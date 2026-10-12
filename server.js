const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SIGNED_DIR = path.join(__dirname, 'signed');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

[UPLOAD_DIR, SIGNED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

function parseMultipart(req, callback) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        return callback(new Error('Content type bukan multipart/form-data'));
    }

    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s]+))/i);
    if (!boundaryMatch) return callback(new Error('Boundary tidak ditemukan'));
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    let body = [];

    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
        const buffer = Buffer.concat(body);
        const result = { fields: {}, files: {} };

        const boundaryBuffer = Buffer.from(`--${boundary}`);
        let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length;

        while (start < buffer.length) {
            const end = buffer.indexOf(boundaryBuffer, start);
            if (end === -1) break;

            const part = buffer.slice(start, end);
            const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
            if (headerEnd === -1) {
                start = end + boundaryBuffer.length;
                continue;
            }

            const headerStr = part.slice(0, headerEnd).toString();
            const content = part.slice(headerEnd + 4, part.length - 2);

            const nameMatch = headerStr.match(/name="([^"]+)"/);
            const filenameMatch = headerStr.match(/filename="([^"]+)"/);

            if (nameMatch) {
                const name = nameMatch[1];
                if (filenameMatch) {
                    const filename = filenameMatch[1];
                    if (filename) {
                        const uniqueName = `${Date.now()}-${filename}`;
                        const filepath = path.join(UPLOAD_DIR, uniqueName);
                        fs.writeFileSync(filepath, content);
                        result.files[name] = { filename, filepath };
                    }
                } else {
                    result.fields[name] = content.toString().trim();
                }
            }
            start = end + boundaryBuffer.length;
        }
        callback(null, result);
    });
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const localIP = getLocalIP();

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(indexPath, (err, data) => {
            if (err) {
                res.writeHead(504, { 'Content-Type': 'text/plain' });
                res.end('504 - Halaman tidak ditemukan');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } 
    else if (req.method === 'GET' && parsedUrl.pathname === '/api/accounts') {
        try {
            const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(accounts));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        }
    }
    else if (req.method === 'GET' && parsedUrl.pathname === '/api/history') {
        try {
            let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            const now = new Date();
            history = history.map(item => {
                const createdDate = new Date(item.timestamp);
                const expiryDate = new Date(createdDate.getTime() + 7 * 24 * 60 * 60 * 1000);
                const diffTime = expiryDate - now;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                return {
                    ...item,
                    daysLeft: diffDays > 0 ? diffDays : 0,
                    isExpired: diffDays <= 0
                };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(history));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([]));
        }
    }
    else if (req.method === 'GET' && parsedUrl.pathname === '/api/server-info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ip: localIP, port: PORT }));
    }
    else if (req.method === 'GET' && parsedUrl.pathname.startsWith('/signed/')) {
        const filePath = path.join(__dirname, parsedUrl.pathname);
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`
            });
            fs.createReadStream(filePath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File IPA tidak ditemukan');
        }
    }
    else if (req.method === 'GET' && parsedUrl.pathname.startsWith('/manifest/')) {
        const queryParams = parsedUrl.searchParams;
        const filename = parsedUrl.pathname.replace('/manifest/', '').replace('.plist', '');
        const appTitle = queryParams.get('name') || 'Custom Sideload App';
        const bundleId = queryParams.get('bundle') || 'com.local.customapp';
        const host = req.headers.host;
        
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>http://${host}/signed/${filename}.ipa</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${bundleId}</string>
                <key>bundle-version</key>
                <string>1.0</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${appTitle}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>`;

        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(plistContent);
    }
    else if (req.method === 'POST' && parsedUrl.pathname === '/api/refresh') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { index } = JSON.parse(body);
                let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));

                if (history[index]) {
                    history[index].timestamp = Date.now();
                    history[index].date = new Date().toLocaleString();

                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Masa aktif berhasil diperpanjang 7 hari!' }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Data riwayat tidak ditemukan.' }));
                }
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Gagal memproses refresh.' }));
            }
        });
    }
    else if (req.method === 'POST' && parsedUrl.pathname === '/sideload') {
        parseMultipart(req, (err, data) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Gagal parsing data: ' + err.message }));
                return;
            }

            const appleId = data.fields.appleId;
            const password = data.fields.password;
            const ipaFile = data.files.ipa;

            if (!appleId || !password || !ipaFile) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Apple ID, Password, dan File IPA wajib diisi!' }));
                return;
            }

            // Default bawaan dari nama file IPA jika opsi advanced tidak diisi
            const originalFilename = path.basename(ipaFile.filename, '.ipa');
            const customAppName = data.fields.appName && data.fields.appName.trim() !== '' 
                ? data.fields.appName 
                : originalFilename;
            
            const customBundleId = data.fields.bundleId && data.fields.bundleId.trim() !== '' 
                ? data.fields.bundleId 
                : `com.local.${originalFilename.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

            // Simpan Akun
            try {
                let accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
                const existingIndex = accounts.findIndex(acc => acc.appleId === appleId);
                if (existingIndex !== -1) {
                    accounts[existingIndex].password = password;
                } else {
                    accounts.push({ appleId, password });
                }
                fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
            } catch (e) {}

            const cleanName = originalFilename.replace(/[^a-zA-Z0-9]/g, '_');
            const uniqueFilename = `${Date.now()}-${cleanName}`;
            const targetSignedPath = path.join(SIGNED_DIR, `${uniqueFilename}.ipa`);

            try {
                fs.copyFileSync(ipaFile.filepath, targetSignedPath);

                const host = req.headers.host;
                const installUrl = `itms-services://?action=download-manifest&url=http://${host}/manifest/${uniqueFilename}.plist?name=${encodeURIComponent(customAppName)}&bundle=${encodeURIComponent(customBundleId)}`;
                const downloadUrl = `/signed/${uniqueFilename}.ipa`;

                // Simpan ke Riwayat
                try {
                    let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
                    history.unshift({
                        appName: customAppName,
                        bundleId: customBundleId,
                        appleId: appleId,
                        filename: ipaFile.filename,
                        installUrl: installUrl,
                        downloadUrl: downloadUrl,
                        timestamp: Date.now(),
                        date: new Date().toLocaleString()
                    });
                    if (history.length > 10) history.pop();
                    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
                } catch (e) {}

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    message: 'Berhasil ditandatangani dan siap diinstal!',
                    installUrl: installUrl,
                    downloadUrl: downloadUrl
                }));

            } catch (processError) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Gagal memproses file pada server.' }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 - Not Found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const activeIP = getLocalIP();
    console.log(`==================================================`);
    console.log(`🚀 Pro Sideloader Server Berhasil Dijalankan!`);
    console.log(`- Akses dari Komputer Ini : http://localhost:${PORT}`);
    console.log(`- Akses dari HP / iPhone   : http://${activeIP}:${PORT}`);
    console.log(`==================================================`);
});