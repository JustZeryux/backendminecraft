require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver'); 
const { Readable } = require('stream');
const http = require('http');
const { Server } = require('socket.io');

// 1. ORDEN VITAL: Primero la app, luego el server, luego los sockets
const app = express();
const server = http.createServer(app);

// 2. Configuración de Socket.io (CORS específico para Cloudflare)
const io = new Server(server, { 
    cors: { 
        origin: "https://coremod.pages.dev", // Asegúrate que esta sea tu URL exacta
        methods: ["GET", "POST"],
        credentials: true
    } 
});

// 3. Configuración de Express y Límites (Fix Error 413)
app.use(cors()); 
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Ruta base
app.get('/', (req, res) => {
    res.send('🚀 API de MinePack Studio Pro (Sockets Activos) funcionando correctamente.');
});

// --- API PRINCIPAL: ENSAMBLADO Y EXPORTACIÓN ---
app.post('/api/export', async (req, res) => {
    try {
        // Extraemos el payload
        const payload = req.body.exportData ? JSON.parse(req.body.exportData) : req.body;
        const { mcVersion, modLoader, mods, worldSettings, socketId } = payload;
        
        let completedMods = 0;
        console.log(`[MinePack] Iniciando ensamblado para MC ${mcVersion} (${mods.length} mods)...`);

        // Cabeceras de descarga
        const zipName = `Mod_Pack_${mcVersion}_${Date.now()}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { 
            console.error('[Archiver Error]', err);
            if (!res.headersSent) res.status(500).send('Error comprimiendo el archivo');
        });
        
        archive.pipe(res);

        // Archivos informativos
        const readmeText = `¡Modpack listo!\nMinecraft: ${mcVersion}\nLoader: ${modLoader}`;
        archive.append(readmeText, { name: 'INSTRUCCIONES.txt' });

        if (worldSettings) {
            let serverProps = `# Generado por MinePack Studio\ngamemode=${worldSettings.gamemode || 'survival'}\ndifficulty=${worldSettings.difficulty || 'normal'}\n`;
            archive.append(serverProps, { name: 'server.properties' });
        }

        // --- LÓGICA DE MODRINTH ---
        const downloadPromises = mods.map(async (modItem) => {
            try {
                const encodedVersion = encodeURIComponent(`["${mcVersion}"]`);
                const encodedLoader = encodeURIComponent(`["${modLoader}"]`);
                
                let strictUrl = `https://api.modrinth.com/v2/project/${modItem.id}/version?game_versions=${encodedVersion}`;
                if (modItem.type === 'mod') strictUrl += `&loaders=${encodedLoader}`;

                let versionRes = await fetch(strictUrl);
                let versions = await versionRes.json();
                
                if (!versions || versions.length === 0) {
                    const fallbackRes = await fetch(`https://api.modrinth.com/v2/project/${modItem.id}/version`);
                    versions = await fallbackRes.json();
                }

                if (versions && versions.length > 0) {
                    const fileData = versions[0].files.find(f => f.primary) || versions[0].files[0];
                    
                    let targetFolder = 'mods';
                    if (modItem.type === 'shader') targetFolder = 'shaderpacks';
                    if (modItem.type === 'resourcepack') targetFolder = 'resourcepacks';

                    const fileResponse = await fetch(fileData.url);
                    if (fileResponse.ok) {
                        const nodeStream = Readable.fromWeb(fileResponse.body);
                        archive.append(nodeStream, { name: `${targetFolder}/${fileData.filename}` });
                    }
                }

                // Reportar progreso al frontend
                completedMods++;
                if (socketId) {
                    const progress = Math.round((completedMods / mods.length) * 100);
                    io.to(socketId).emit('download-progress', { 
                        progress, 
                        currentMod: modItem.title || 'Archivo' 
                    });
                }

            } catch (err) {
                console.error(`[Error] Falló ${modItem.id}: ${err.message}`);
            }
        });

        await Promise.all(downloadPromises);

        // Finalización segura de la respuesta
        const finalizeArchive = () => {
            return new Promise((resolve, reject) => {
                res.on('finish', () => resolve());
                res.on('error', (err) => reject(err));
                archive.finalize();
            });
        };

        await finalizeArchive();

    } catch (error) {
        console.error("[ERROR FATAL]", error);
        if(!res.headersSent) res.status(500).json({ error: "Fallo en el servidor." });
    }
});

// USAR server.listen para que los sockets funcionen
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
