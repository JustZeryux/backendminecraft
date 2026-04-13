require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const archiver = require('archiver'); 
const { Readable } = require('stream');

// 1. INICIALIZAR EXPRESS
const app = express();

// 2. CREAR EL SERVIDOR HTTP
// Es fundamental pasarle la app de Express al servidor HTTP
const server = http.createServer(app);

// 3. INICIALIZAR SOCKET.IO Y CONFIGURAR SU CORS (ESTO SOLUCIONA TU ERROR EN CONSOLA)
const io = new Server(server, {
    cors: {
        origin: ['https://coremod.pages.dev', 'http://localhost:3000'],
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    }
});

// 4. CONFIGURAR MIDDLEWARES DE EXPRESS
app.use(cors({
    origin: ['https://coremod.pages.dev', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// 5. EVENTOS DE SOCKET.IO
io.on('connection', (socket) => {
    console.log(`Un usuario se ha conectado a WebSockets: ${socket.id}`);
    
    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);
    });
});

// 6. RUTAS DE EXPRESS
app.get('/', (req, res) => {
    res.send('🚀 Servidor de MinePack Studio Activo y Escuchando.');
});

// --- RUTA DE EXPORTACIÓN ---
app.post('/api/export', async (req, res) => {
    try {
        const payload = req.body.exportData ? JSON.parse(req.body.exportData) : req.body;
        const { mcVersion, modLoader, mods, worldSettings, socketId } = payload;
        
        let completedMods = 0;
        console.log(`[MinePack] Armando ZIP para MC ${mcVersion}...`);

        const zipName = `Mod_Pack_${mcVersion}_${Date.now()}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { 
            console.error('[Archiver Error]', err);
            if (!res.headersSent) res.status(500).send('Error comprimiendo');
        });
        
        archive.pipe(res);

        // Archivos base
        archive.append(`Modpack listo!\nMinecraft: ${mcVersion}\nLoader: ${modLoader}`, { name: 'INSTRUCCIONES.txt' });

        if (worldSettings) {
            let serverProps = `# Generado por MinePack Studio\ngamemode=${worldSettings.gamemode || 'survival'}\n`;
            archive.append(serverProps, { name: 'server.properties' });
        }

        // Descarga de mods
        const downloadPromises = mods.map(async (modItem) => {
            try {
                const encodedVersion = encodeURIComponent(`["${mcVersion}"]`);
                const encodedLoader = encodeURIComponent(`["${modLoader}"]`);
                let url = `https://api.modrinth.com/v2/project/${modItem.id}/version?game_versions=${encodedVersion}`;
                if (modItem.type === 'mod') url += `&loaders=${encodedLoader}`;

                let resMod = await fetch(url);
                let versions = await resMod.json();
                
                if (versions && versions.length > 0) {
                    const fileData = versions[0].files.find(f => f.primary) || versions[0].files[0];
                    let folder = modItem.type === 'shader' ? 'shaderpacks' : (modItem.type === 'resourcepack' ? 'resourcepacks' : 'mods');
                    
                    const fileRes = await fetch(fileData.url);
                    if (fileRes.ok) {
                        archive.append(Readable.fromWeb(fileRes.body), { name: `${folder}/${fileData.filename}` });
                    }
                }

                // Notificar progreso usando la instancia "io" global
                completedMods++;
                if (socketId) {
                    const progress = Math.round((completedMods / mods.length) * 100);
                    io.to(socketId).emit('download-progress', { progress, currentMod: modItem.title || 'Archivo' });
                }
                
            } catch (e) { console.error("Error en mod:", modItem.id); }
        });

        await Promise.all(downloadPromises);

        if (socketId) {
            io.to(socketId).emit('download-progress', { 
                progress: 100, 
                currentMod: 'Empaquetando y transfiriendo ZIP... (No cierres la página)' 
            });
        }
        const finalize = () => new Promise((resolve, reject) => {
            res.on('finish', () => resolve());
            res.on('error', reject);
            archive.finalize();
        });

        await finalize();

    } catch (error) {
        console.error("[ERROR]", error);
        if(!res.headersSent) res.status(500).json({ error: "Fallo el servidor." });
    }
});

// 7. INICIAR EL SERVIDOR (Siempre "server", NUNCA "app")
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Motor de MinePack listo en el puerto ${PORT}`);
});
