require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver'); 
const { Readable } = require('stream');
const http = require('http');
const { Server } = require('socket.io');

// 1. Inicialización correcta (Orden Vital)
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { 
        origin: "https://coremod.pages.dev", // <--- TU URL DE CLOUDFLARE
        methods: ["GET", "POST"],
        credentials: true
    } 
});
// 2. Configuración de límites (Fix Error 413)
app.use(cors()); 
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));

app.get('/', (req, res) => {
    res.send('🚀 API de MinePack Studio Pro funcionando correctamente.');
});

app.post('/api/export', async (req, res) => {
    try {
        // Extraemos el payload una sola vez
        const payload = req.body.exportData ? JSON.parse(req.body.exportData) : req.body;
        const { mcVersion, modLoader, mods, worldSettings, socketId } = payload;
        
        let completedMods = 0;
        console.log(`[MinePack] Ensamblando Modpack para MC ${mcVersion} (${mods.length} mods)...`);

        // Configuración de descarga
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
        const readmeText = `¡Modpack listo!\nMinecraft: ${mcVersion}\nLoader: ${modLoader}`;
        archive.append(readmeText, { name: 'INSTRUCCIONES.txt' });

        if (worldSettings) {
            let serverProps = `# Generado por MinePack Studio\ngamemode=${worldSettings.gamemode || 'survival'}\n`;
            archive.append(serverProps, { name: 'server.properties' });
        }

        // --- LÓGICA DE MODRINTH (Recuperada y Mejorada) ---
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
                    
                    // Definimos carpeta destino
                    let targetFolder = 'mods';
                    if (modItem.type === 'shader') targetFolder = 'shaderpacks';
                    if (modItem.type === 'resourcepack') targetFolder = 'resourcepacks';

                    // Descarga vía Stream
                    const fileResponse = await fetch(fileData.url);
                    if (fileResponse.ok) {
                        const nodeStream = Readable.fromWeb(fileResponse.body);
                        archive.append(nodeStream, { name: `${targetFolder}/${fileData.filename}` });
                    }
                }

                // Notificar progreso vía Socket
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

        // Finalización segura
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
        if(!res.headersSent) res.status(500).json({ error: "Error en el servidor." });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor Pro listo en puerto ${PORT}`);
});
