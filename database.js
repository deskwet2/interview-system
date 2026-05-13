const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'interview_system.db'), (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log("Connected to the SQLite database.");
});

const initDb = () => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            console.log("Wiping existing data and re-initializing database...");

            // 0. DROP EXISTING TABLES (Clean Slate)
            // Note: Drop in reverse order of foreign keys if needed
            db.run(`DROP TABLE IF EXISTS mailer_settings`);
            db.run(`DROP TABLE IF EXISTS interactions`);
            db.run(`DROP TABLE IF EXISTS candidates`);
            db.run(`DROP TABLE IF EXISTS screens`);
            db.run(`DROP TABLE IF EXISTS categories`);
            db.run(`DROP TABLE IF EXISTS examiners`);

            // 1. Categories
            db.run(`CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                default_redirect_url TEXT
            )`);

            // 2. Screens
            db.run(`CREATE TABLE IF NOT EXISTS screens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER,
                screen_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                is_default INTEGER DEFAULT 0,
                FOREIGN KEY (category_id) REFERENCES categories (id)
            )`);

            // 3. Candidates
            db.run(`CREATE TABLE IF NOT EXISTS candidates (
                email TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category_id INTEGER,
                status TEXT DEFAULT 'offline',
                last_socket_id TEXT,
                last_connected DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES categories (id)
            )`);

            // 4. Interactions
            db.run(`CREATE TABLE IF NOT EXISTS interactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                candidate_email TEXT,
                type TEXT CHECK(type IN ('command', 'response')),
                screen_file TEXT,
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (candidate_email) REFERENCES candidates (email)
            )`);

            // 5. Mailing Records Table
            db.run(`CREATE TABLE IF NOT EXISTS mailer_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT,
                port INTEGER,
                user TEXT,
                pass TEXT,
                from_email TEXT,
                is_active INTEGER DEFAULT 0
            )`);

            // 6. Examiners Table
            db.run(`CREATE TABLE IF NOT EXISTS examiners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT,
                telegram_key TEXT,
                chat_id TEXT,
                status INTEGER DEFAULT 1,
                is_moderator INTEGER DEFAULT 0
            )`, (err) => {
                if (err) {
                    reject(err);
                } else {
                    // Auto-create a default admin
                    db.run(`INSERT INTO examiners (username, password, email, is_moderator) 
                            VALUES ('admin', 'admin123', 'deskwet2@gmail.com', 1)`, (insertErr) => {
                        if (!insertErr) {
                            console.log("Default moderator account created: admin/admin123");
                        }
                    });
                    
                    console.log("Database initialized from scratch.");
                    resolve();
                }
            });
        });
    });
};

module.exports = { db, initDb };