const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { db, initDb } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize SQLite Tables
initDb();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screens', express.static(path.join(__dirname, 'screens')));


// Memory Map to link Email to the current Active Socket
let emailToSocket = {}; 

io.on('connection', (socket) => {
    console.log('New connection attempt...');

    /**
     * POINT 6: HANDLE REFRESH BUG (Identity by Email)
     */
    socket.on('join_interview', async (data) => {
        const { name, email, categoryId } = data;
        emailToSocket[email] = socket.id;
        socket.email = email;

        // FIX 1: Always update the DB to 'live' immediately on join/refresh
        db.run(`UPDATE candidates SET status = 'live' WHERE email = ?`, [email]);

        db.get(`SELECT * FROM candidates WHERE email = ?`, [email], (err, candidate) => {
            if (candidate) {
                // REFRESH SCENARIO
                db.all(`SELECT * FROM interactions WHERE candidate_email = ? ORDER BY timestamp ASC`, [email], (err, history) => {
                    socket.emit('restore_session', { candidate, history });
                    
                    // Fetch category name for the examiner's UI
                    db.get(`SELECT name FROM categories WHERE id = ?`, [candidate.category_id], (err, cat) => {
                        io.emit('candidate_online', { 
                            ...candidate, 
                            status: 'live',
                            category_name: cat ? cat.name : 'General' 
                        });
                    });
                });
            } else {
                // NEW CANDIDATE SCENARIO
                db.run(`INSERT INTO candidates (email, name, category_id, status) VALUES (?, ?, ?, 'live')`, 
                    [email, name, categoryId], function() {
                    
                    db.get(`SELECT file_path FROM screens WHERE category_id = ? AND is_default = 1`, [categoryId], (err, screen) => {
                        if (screen) {
                            socket.emit('new_task', { screenFile: screen.file_path, header: "Welcome", subHeader: "Please begin." });
                        }
                    });

                    db.get(`SELECT name FROM categories WHERE id = ?`, [categoryId], (err, cat) => {
                        io.emit('candidate_online', { 
                            email, name, category_id: categoryId, 
                            status: 'live', 
                            category_name: cat ? cat.name : 'General' 
                        });
                    });
                });
            }
        });
    });



    socket.on('disconnect', () => {
        if (socket.email) {
            // FIX 2: Use a callback for the disconnect to ensure the emit happens 
            // AFTER the database has successfully marked them offline
            db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [socket.email], () => {
                io.emit('candidate_offline', socket.email);
                console.log(`Candidate ${socket.email} is now offline.`);
            });
            
            // Clean up memory map
            delete emailToSocket[socket.email];
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
        db.run(`DELETE FROM interactions WHERE candidate_email = ?`, [email], () => {
            db.get(`SELECT s.file_path FROM screens s 
                    JOIN candidates c ON c.category_id = s.category_id 
                    WHERE c.email = ? AND s.is_default = 1`, [email], (err, screen) => {
                if (screen) {
                    io.to(emailToSocket[email]).emit('new_task', { screenFile: screen.file_path, header: "Session Reset" });
                }
            });
        });
    });

    /**
     * POINT 7: REMOVE CANDIDATE
     */
    socket.on('remove_candidate', (email) => {
        db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [email], () => {
            io.to(emailToSocket[email]).emit('force_disconnect');
            io.emit('candidate_removed', email);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enterprise Server Live on ${PORT}`));