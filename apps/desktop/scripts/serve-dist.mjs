import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve("dist");
const port = 5173;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url ?? "/", `http://localhost:${port}`).pathname);
  const requestedPath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(root, requestedPath === "/" ? "index.html" : requestedPath);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    filePath = path.join(root, "index.html");
  }

  response.setHeader("Content-Type", types[path.extname(filePath)] ?? "application/octet-stream");
  createReadStream(filePath)
    .on("error", () => {
      response.statusCode = 404;
      response.end("Not found");
    })
    .pipe(response);
});

server.listen(port, () => {
  console.log(`Serving dist at http://localhost:${port}/`);
});
