require('dotenv').config();
const express = require('express');
const cors = require('cors');
const archiver = require('archiver'); 
const { Readable } = require('stream');

const app = express();

// Configuración de seguridad y lectura de datos
app.use(cors()); // Permite que tu frontend en Cloudflare se conecte aquí
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta de "Health Check" (Para que Render/Railway sepan que el server está vivo)
app.get('/', (req, res) => {
    res.send('🚀 API de MinePack Studio funcionando correctamente.');
});

// --- API PRINCIPAL: ENSAMBLADO Y EXPORTACIÓN FINAL ---
app.post('/api/export', async (req, res) => {
    try {
        // Leemos los datos que envía el frontend
        const payload = req.body.exportData ? JSON.parse(req.body.exportData) : req.body;
        const { mcVersion, modLoader, mods, worldSettings } = payload;
        
        console.log(`[MinePack] Iniciando ensamblado de Modpack para MC ${mcVersion} (${mods.length} items)...`);

        // 1. Configuramos el navegador del usuario para que entienda que va a recibir un archivo descargable
        const zipName = `Mod_Pack_${mcVersion}_${Date.now()}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

        // 2. Iniciamos el motor de compresión ZIP
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        // Si el compresor falla, detenemos el proceso
        archive.on('error', (err) => { 
            console.error('[Archiver Error]', err);
            if (!res.headersSent) res.status(500).send('Error comprimiendo el archivo');
        });
        
        // CONEXIÓN VITAL: Conectamos la salida del ZIP directamente a la respuesta web (Stream)
        archive.pipe(res);

        // --- GENERACIÓN DE ARCHIVOS DE TEXTO AL VUELO ---
        const readmeText = `¡Tu Modpack de MinePack Studio está listo!
Version de Minecraft: ${mcVersion}
Mod Loader: ${modLoader}

=========================================
1. COMO INSTALAR EN TU PC (Para poder jugar)
=========================================
1. Instala ${modLoader} ${mcVersion} en tu cliente de Minecraft.
2. Presiona las teclas Win + R, escribe %appdata% y presiona Enter.
3. Entra a la carpeta .minecraft.
4. Pega las carpetas 'mods', 'shaderpacks' y 'resourcepacks' de este ZIP alli adentro.
5. Abre tu Launcher de Minecraft, selecciona el perfil de ${modLoader} y a jugar.`;

        archive.append(readmeText, { name: 'INSTRUCCIONES.txt' });

        if (worldSettings) {
            let serverPropsText = `# Generado por MinePack Studio\ngamemode=${worldSettings.gamemode || 'survival'}\ndifficulty=${worldSettings.difficulty || 'normal'}\n`;
            if (worldSettings.seed && worldSettings.seed.trim() !== '') {
                serverPropsText += `level-seed=${worldSettings.seed}\n`;
            }
            archive.append(serverPropsText, { name: 'server.properties' });
        }

        // --- DESCARGA E INYECCIÓN DE MODS AL ZIP ---
        const downloadPromises = mods.map(async (modItem) => {
            try {
                // Preparamos los filtros para la API de Modrinth
                const encodedVersion = encodeURIComponent(`["${mcVersion}"]`);
                const encodedLoader = encodeURIComponent(`["${modLoader}"]`);
                
                let strictUrl = `https://api.modrinth.com/v2/project/${modItem.id}/version?game_versions=${encodedVersion}`;
                if (modItem.type === 'mod') strictUrl += `&loaders=${encodedLoader}`;

                // Buscamos la versión correcta
                let versionRes = await fetch(strictUrl);
                let versions = await versionRes.json();
                
                // Modo rescate (si no hay versión exacta, probamos sin filtros)
                if (!versions || versions.length === 0) {
                    const fallbackRes = await fetch(`https://api.modrinth.com/v2/project/${modItem.id}/version`);
                    versions = await fallbackRes.json();
                }

                if (!versions || versions.length === 0) return; // Si definitivamente no existe, lo saltamos

                const fileData = versions[0].files.find(f => f.primary) || versions[0].files[0];
                
                let targetFolder = 'mods';
                if (modItem.type === 'shader') targetFolder = 'shaderpacks';
                if (modItem.type === 'resourcepack') targetFolder = 'resourcepacks';

                // Descargamos el archivo .jar
                const fileResponse = await fetch(fileData.url);
                if (!fileResponse.ok) throw new Error("Error en la descarga desde Modrinth");
                
                // MODO STREAM: Pasamos la descarga directamente al compresor ZIP sin guardarla en memoria
                const nodeStream = Readable.fromWeb(fileResponse.body);
                archive.append(nodeStream, { name: `${targetFolder}/${fileData.filename}` });
                
                console.log(`[MinePack] Inyectando: ${fileData.filename}`);

            } catch (err) {
                console.error(`[Error] Falló la descarga de ${modItem.title || modItem.id}: ${err.message}`);
            }
        });

        // Esperamos a que todos los mods terminen de inyectarse
        await Promise.all(downloadPromises);

        // Finalizamos el ZIP. Esto cierra el archivo y le dice al navegador del usuario "Descarga completada".
        await archive.finalize();
        console.log(`[MinePack] Ensamblado finalizado con éxito.`);

    } catch (error) {
        console.error("[ERROR FATAL EN ENSAMBLADO]", error);
        if(!res.headersSent) res.status(500).json({ error: "Fallo el ensamblado final." });
    }
});

// Inicializamos el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Híbrido Activo en el puerto ${PORT}`);
});