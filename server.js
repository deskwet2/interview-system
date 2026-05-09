const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { db, initDb } = require('./database');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const https = require('https');
const app = express();
const server = http.createServer(app);
const io = new Server(server);


// Initialize SQLite Tables
initDb();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screens', express.static(path.join(__dirname, 'screens')));


/**
 * CHECK BOT GATEWAY MIDDLEWARE
 */
const gatewayCheck = (req, res, next) => {
    // 1. Define paths that should NEVER be redirected
    const isPublicPath = ['/', '/gatekeeper', '/api/verify-human'].includes(req.path);
    const isApiPath = req.path.startsWith('/api/');
    
    // 2. Allow if verified, or if it's a public path
    if (req.cookies.verified_human || isPublicPath) {
        return next();
    }
    
    // 3. If it's an API call but not verified, send a 401 JSON error instead of HTML redirect
    if (isApiPath) {
        return res.status(401).json({ error: "Verification required" });
    }

    // 4. Otherwise, redirect humans to the gatekeeper
    res.redirect('/gatekeeper');
};
app.use(gatewayCheck);


/**
 * LOOPHOLE 1: DUAL NOTIFICATION SYSTEM
 */
async function notifyExaminers(candidateName, categoryName) {
    const textMsg = `🔔 New Candidate: ${candidateName}\n💼 Category: ${categoryName}`;

    // Get Active Settings and Examiners
    db.get(`SELECT * FROM mailer_settings WHERE is_active = 1`, [], (err, smtp) => {
        db.all(`SELECT telegram_key, chat_id, email FROM examiners WHERE status = 1`, [], (err, examiners) => {
            if (err || !examiners) return;

            examiners.forEach(ex => {
                // Telegram Channel
                if (ex.telegram_key && ex.chat_id) {
                    const url = `https://api.telegram.org/bot${ex.telegram_key}/sendMessage?chat_id=${ex.chat_id}&text=${encodeURIComponent(textMsg)}`;
                    https.get(url).on('error', (e) => console.error("Telegram Fail:", e.message));
                }

                // Email Channel
                if (ex.email && smtp) {
                    let transporter = nodemailer.createTransport({
                        host: smtp.host,
                        port: smtp.port,
                        secure: smtp.port === 465,
                        auth: { user: smtp.user, pass: smtp.pass }
                    });
                    transporter.sendMail({
                        from: smtp.from_email,
                        to: ex.email,
                        subject: "New Interview Candidate",
                        text: textMsg
                    }).catch(e => console.error("Email Fail:", e.message));
                }
            });
        });
    });
}




// Memory Map to link Email to the current Active Socket
let emailToSocket = {};
let joinAttempts = {};

io.on('connection', (socket) => {
    

    /**
     * POINT 6: HANDLE REFRESH BUG (Identity by Email)
     */
    socket.on('join_interview', async (data) => {
        const { name, email, categoryId } = data;
        
        // LOOPHOLE 2: Check for Online Examiners
        db.get(`SELECT COUNT(*) as activeCount FROM examiners WHERE status = 1`, [], (err, row) => {
            if (!row || row.activeCount === 0) {
                joinAttempts[email] = (joinAttempts[email] || 0) + 1;
                
                if (joinAttempts[email] > 3) {
                    // Redirect to default category URL after 3 fails
                    db.get(`SELECT default_redirect_url FROM categories WHERE id = ?`, [categoryId], (err, cat) => {
                        socket.emit('redirect_command', { url: cat ? cat.default_redirect_url : '/' });
                        delete joinAttempts[email];
                    });
                    return;
                }
                // Notify examiners anyway (in case they forgot to toggle) and tell candidate to retry
                notifyExaminers(name, "WAITING - " + (joinAttempts[email]));
                socket.emit('retry_connection', { attempt: joinAttempts[email] });
                return;
            }

            // Normal Joining Logic (from your original file)
            emailToSocket[email] = socket.id;
            socket.email = email;
            joinAttempts[email] = 0;

            db.run(`UPDATE candidates SET status = 'live' WHERE email = ?`, [email], () => {
                db.get(`SELECT * FROM candidates WHERE email = ?`, [email], (err, candidate) => {
                    if (candidate) {
                        db.all(`SELECT * FROM interactions WHERE candidate_email = ? ORDER BY timestamp ASC`, [email], (err, history) => {
                            socket.emit('restore_session', { candidate, history });
                            db.get(`SELECT name FROM categories WHERE id = ?`, [candidate.category_id], (err, cat) => {
                                io.emit('candidate_online', { ...candidate, status: 'live', category_name: cat ? cat.name : 'General' });
                            });
                        });
                    } else {
                        db.run(`INSERT INTO candidates (email, name, category_id, status) VALUES (?, ?, ?, 'live')`, 
                            [email, name, categoryId], function() {
                            db.get(`SELECT file_path FROM screens WHERE category_id = ? AND is_default = 1`, [categoryId], (err, screen) => {
                                if (screen) socket.emit('new_task', { screenFile: screen.file_path, header: "Welcome", subHeader: "Please begin." });
                            });
                            db.get(`SELECT name FROM categories WHERE id = ?`, [categoryId], (err, cat) => {
                                notifyExaminers(name, cat ? cat.name : 'General');
                                io.emit('candidate_online', { email, name, category_id: categoryId, status: 'live', category_name: cat ? cat.name : 'General' });
                            });
                        });
                    }
                });
            });
        });
    });


    socket.on('retry_connection', (data) => {
        showOverlay(`No examiners online. Retrying... (Attempt ${data.attempt}/3)`);
        setTimeout(() => {
            // Re-trigger the join call automatically
            socket.emit('join_interview', { name, email, categoryId });
        }, 5000); // 5 second delay between retries
    });


    // LOOPHOLE 3: Examiner Status Toggle
    socket.on('toggle_online', (data) => {
        const status = data.isOnline ? 1 : 0;
        db.run(`UPDATE examiners SET status = ? WHERE username = ?`, [status, data.username]);
    });



    socket.on('disconnect', () => {
        if (socket.email) {
            const email = socket.email;

            // Check if this specific socket is still the "active" one for this email
            // If the user refreshed, emailToSocket[email] will already point to a NEW socket ID
            if (emailToSocket[email] === socket.id) {
                db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [email], () => {
                    io.emit('candidate_offline', email);
                    console.log(`Candidate ${email} is now offline.`);
                    
                    // Only delete from map if it's the current socket
                    delete emailToSocket[email];
                });
            }

            db.run(`UPDATE examiners SET status = 0 WHERE socket_id = ?`, [socket.id]);
        }
    });

    /**
     * POINT 3 & 4: SCREEN TRIGGER & REDIRECTION
     */
    socket.on('trigger_screen', (data) => {
        const { candidateEmail, screenFile, header, subHeader, isRedirect, customUrl } = data;
        const targetSocket = emailToSocket[candidateEmail];

        if (isRedirect) {
            // Logic for Point 4: Redirection
            if (customUrl) {
                io.to(targetSocket).emit('redirect_command', { url: customUrl });
            } else {
                db.get(`SELECT c.default_redirect_url FROM categories c 
                        JOIN candidates cand ON cand.category_id = c.id 
                        WHERE cand.email = ?`, [candidateEmail], (err, row) => {
                    io.to(targetSocket).emit('redirect_command', { url: row.default_redirect_url });
                });
            }
        } else {
            const payload = { screenFile, header, subHeader };
            // Save to History (Point 3)
            db.run(`INSERT INTO interactions (candidate_email, type, screen_file, content) VALUES (?, 'command', ?, ?)`,
                [candidateEmail, screenFile, `Command: ${header}`]);
            
            io.to(targetSocket).emit('new_task', payload);
        }
    });

    /**
     * POINT 5: RESET SESSION
     */
    socket.on('reset_candidate', (email) => {
        // 1. SKIP DELETE: We are not clearing interactions/history anymore.
        
        // 2. Find the default screen for this candidate's category
        db.get(`SELECT s.file_path, s.screen_name FROM screens s 
                JOIN candidates c ON c.category_id = s.category_id 
                WHERE c.email = ? AND s.is_default = 1`, [email], (err, screen) => {
            
            const targetSocketId = emailToSocket[email];
            
            if (err) return console.error("Reset Error:", err);

            if (screen && targetSocketId) {
                const payload = { 
                    screenFile: screen.file_path, 
                    header: "Welcome", 
                    subHeader: "Please begin the process." 
                };

                // 3. DO NOT trigger a page reload. 
                // Just tell the candidate to wipe their 'current_task' and show the new one.
                io.to(targetSocketId).emit('force_reset_silent', payload);
            }
        });
    });

    /**
     * POINT 7: REMOVE CANDIDATE
     */
    socket.on('remove_candidate', (email) => {
        const targetSocketId = emailToSocket[email];

        // 1. Mark as offline in DB
        db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [email], () => {
            
            if (targetSocketId) {
                // 2. Tell the candidate to disconnect and clear their local data
                io.to(targetSocketId).emit('force_logout');
                
                // 3. Forcefully close the socket on the server
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) targetSocket.disconnect(true);
            }

            // 4. Clean up our tracking map
            delete emailToSocket[email];

            // 5. Tell all examiners to remove this person from their "Live" lists
            io.emit('candidate_offline', email);
        });
    });

    /**
     * DATA SUBMISSION (Point 3)
     */
    socket.on('task_submitted', (data) => {
        const { email, screenFile, answer } = data;
        db.run(`INSERT INTO interactions (candidate_email, type, screen_file, content) VALUES (?, 'response', ?, ?)`,
            [email, screenFile, answer], () => {
            io.emit('notify_submission', { email, answer, screenFile });
        });
    });


    /**
     * REFRESH FIX: Fetching the Full Candidate List for Examiner
     */
    socket.on('request_list_refresh', () => {
        const sql = `
            SELECT c.*, cat.name as category_name 
            FROM candidates c 
            LEFT JOIN categories cat ON c.category_id = cat.id
        `;
        db.all(sql, [], (err, rows) => {
            socket.emit('sync_sessions', rows);
        });
    });

    /**
     * POINT 2: Fetching screens for the Examiner's Command Panel
     */
    socket.on('get_category_screens', (categoryId) => {
        db.all(`SELECT * FROM screens WHERE category_id = ?`, [categoryId], (err, rows) => {
            socket.emit('receive_screens', rows);
        });
    });

    /**
     * POINT 3: Fetching history when a candidate is selected
     */
    socket.on('get_candidate_history', (email) => {
        db.all(`SELECT * FROM interactions WHERE candidate_email = ? ORDER BY timestamp ASC`, [email], (err, rows) => {
            socket.emit('receive_history', rows);
        });
    });


    socket.on('mark_wrong', (data) => {
        const { candidateEmail, message } = data;
        const targetSocket = emailToSocket[candidateEmail];
        if (targetSocket) {
            io.to(targetSocket).emit('wrong_answer', { message });
        }
    });
});

/**
 * POINT 8 & 9: MANAGEMENT API (For Admin UI)
 */
app.get('/api/candidates', (req, res) => {
    db.all(`SELECT * FROM candidates`, [], (err, rows) => res.json(rows));
});

app.post('/api/categories', express.json(), (req, res) => {
    const { name, url } = req.body;
    db.run(`INSERT INTO categories (name, default_redirect_url) VALUES (?, ?)`, [name, url], () => res.sendStatus(200));
});

// --- MISSING ENDPOINTS FOR MODERATOR.HTML ---

/**
 * 1. GET ALL SCREENS
 * Fetches all screens with their associated category names for the admin table
 */
app.get('/api/all-screens', (req, res) => {
    const sql = `
        SELECT s.*, c.name as category_name 
        FROM screens s 
        LEFT JOIN categories c ON s.category_id = c.id
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

/**
 * 2. ADD NEW SCREEN
 * Links a physical HTML file to a job category
 */
app.post('/api/screens', express.json(), (req, res) => {
    const { categoryId, name, path, isDefault } = req.body;
    
    // If setting as default, unset other defaults for this category first
    if (isDefault) {
        db.run(`UPDATE screens SET is_default = 0 WHERE category_id = ?`, [categoryId], () => {
            db.run(`INSERT INTO screens (category_id, screen_name, file_path, is_default) VALUES (?, ?, ?, ?)`,
                [categoryId, name, path, 1], () => res.sendStatus(200));
        });
    } else {
        db.run(`INSERT INTO screens (category_id, screen_name, file_path, is_default) VALUES (?, ?, ?, ?)`,
            [categoryId, name, path, 0], () => res.sendStatus(200));
    }
});

/**
 * 3. DELETE CATEGORY
 */
app.delete('/api/categories/:id', (req, res) => {
    db.run(`DELETE FROM categories WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.sendStatus(200);
    });
});

/**
 * 4. DELETE SCREEN
 */
app.delete('/api/screens/:id', (req, res) => {
    db.run(`DELETE FROM screens WHERE id = ?`, [req.params.id], (err) => {
        if (err) return res.status(500).send(err.message);
        res.sendStatus(200);
    });
});

/**
 * 5. PURGE CANDIDATE
 * Completely removes candidate and their interaction history from the DB
 */
app.delete('/api/candidates/:email', (req, res) => {
    const email = req.params.email;
    db.run(`DELETE FROM interactions WHERE candidate_email = ?`, [email], () => {
        db.run(`DELETE FROM candidates WHERE email = ?`, [email], (err) => {
            if (err) return res.status(500).send(err.message);
            res.sendStatus(200);
        });
    });
});

app.get('/api/vacancies', (req, res) => {
    db.all(`SELECT id, name FROM categories`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 1. Get all examiners
app.get('/api/examiners', (req, res) => {
    db.all(`SELECT id, username, chat_id, status, is_moderator FROM examiners`, [], (err, rows) => {
        res.json(rows);
    });
});

// 2. Add new examiner
app.post('/api/examiners', express.json(), (req, res) => {
    const { username, pass, tkey, chatid, isMod } = req.body;
    db.run(`INSERT INTO examiners (username, password, telegram_key, chat_id, is_moderator) VALUES (?, ?, ?, ?, ?)`,
        [username, pass, tkey, chatid, isMod], (err) => {
            if (err) return res.status(500).send(err.message);
            res.sendStatus(200);
        });
});

// 3. Delete examiner
app.delete('/api/examiners/:id', (req, res) => {
    db.run(`DELETE FROM examiners WHERE id = ?`, [req.params.id], (err) => {
        res.sendStatus(200);
    });
});

// 4. LOGIN ENDPOINT (Critical for security)
app.post('/api/login', express.json(), (req, res) => {
    const { username, password } = req.body;
    
    // 1. Remove "AND status = 1" from the query to allow login even if currently offline
    const query = `SELECT id, username, is_moderator FROM examiners 
                   WHERE username = ? AND password = ?`;

    db.get(query, [username, password], (err, user) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Server error" });
        }

        if (user) {
            // 2. Set the examiner to Online (status = 1) immediately upon success
            db.run(`UPDATE examiners SET status = 1 WHERE id = ?`, [user.id], (updateErr) => {
                if (updateErr) {
                    console.error("Failed to update status on login:", updateErr);
                }
                
                const role = user.is_moderator ? 'moderator' : 'examiner';
                
                console.log(`Examiner ${username} logged in and is now ONLINE.`);

                res.json({ 
                    success: true, 
                    role: role,
                    username: user.username // Helpful for frontend to track who is live
                });
            });
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials" });
        }
    });
});


/**
 * LOOPHOLE 4: ROUTING
 */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html'))); // Landing page
app.get('/interview', (req, res) => res.sendFile(path.join(__dirname, 'public/portal.html'))); // Interview UI
app.get('/gatekeeper', (req, res) => res.sendFile(path.join(__dirname, 'public/gatekeeper.html')));

/**
 * LOOPHOLE 1: SMTP MANAGEMENT API
 */
app.get('/api/mailer', (req, res) => {
    db.all(`SELECT id, host, port, user, is_active FROM mailer_settings`, [], (err, rows) => res.json(rows));
});

app.post('/api/mailer', (req, res) => {
    const { host, port, user, pass, from_email } = req.body;
    db.run(`UPDATE mailer_settings SET is_active = 0`, [], () => {
        db.run(`INSERT INTO mailer_settings (host, port, user, pass, from_email, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
            [host, port, user, pass, from_email], () => res.sendStatus(200));
    });
});

app.delete('/api/mailer/:id', (req, res) => {
    db.run(`DELETE FROM mailer_settings WHERE id = ?`, [req.params.id], () => res.sendStatus(200));
});

// Human Verification Endpoint
app.post('/api/verify-human', (req, res) => {
    res.cookie('verified_human', 'true', { maxAge: 3600000, httpOnly: true });
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enterprise Server Live on ${PORT}`));