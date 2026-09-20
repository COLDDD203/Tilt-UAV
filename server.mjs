import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist')
const port = Number(process.env.PORT || 4173)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (filename !== root && !filename.startsWith(root + path.sep)) { res.writeHead(403); res.end('Forbidden'); return }
    const body = await fs.readFile(filename)
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
    res.end(body)
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('文件未找到。请先运行 npm run build。') }
})
server.on('error', error => { console.error(`无法启动网站：${error.message}`); process.exit(1) })
server.listen(port, '127.0.0.1', () => console.log(`TiltLab: http://127.0.0.1:${port}`))
