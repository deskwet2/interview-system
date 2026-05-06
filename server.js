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
        socket.email = email; // Attach email to socket object

        // Check if candidate exists
        db.get(`SELECT * FROM candidates WHERE email = ?`, [email], (err, candidate) => {
            if (candidate) {
                // REFRESH SCENARIO: Load history and last state
                db.all(`SELECT * FROM interactions WHERE candidate_email = ? ORDER BY timestamp ASC`, [email], (err, history) => {
                    socket.emit('restore_session', { candidate, history });
                    io.emit('candidate_online', { ...candidate, status: 'live' });
                });
            } else {
                // NEW CANDIDATE SCENARIO
                db.run(`INSERT INTO candidates (email, name, category_id, status) VALUES (?, ?, ?, 'live')`, 
                    [email, name, categoryId], () => {
                    
                    // Fetch default screen for this category (Point 2)
                    db.get(`SELECT file_path FROM screens WHERE category_id = ? AND is_default = 1`, [categoryId], (err, screen) => {
                        if (screen) {
                            const payload = { screenFile: screen.file_path, header: "Welcome", subHeader: "Please begin." };
                            socket.emit('new_task', payload);
                        }
                    });
                    io.emit('candidate_online', { email, name, category_id: categoryId, status: 'live' });
                });
            }
        });
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

    socket.on('disconnect', () => {
        if (socket.email) {
            db.run(`UPDATE candidates SET status = 'offline' WHERE email = ?`, [socket.email]);
            io.emit('candidate_offline', socket.email);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Enterprise Server Live on ${PORT}`));