import { createServer } from "vite";
const file = process.argv[2];
const server = await createServer({ configFile: false, server:{middlewareMode:true}, optimizeDeps:{noDiscovery:true} });
try {
  const r = await server.transformRequest(file, { ssr: true });
  const code = r.code;
  console.log("CODE LENGTH", code.length);
  // Try to parse it as a module via node vm to find the bad token
  try { new Function(code.replace(/import\s/g,'//import ').replace(/export\s/g,'//export ')); console.log("Function-parse OK (rough)"); }
  catch(e){ console.log("PARSE ERR:", e.message); }
  // find suspicious sequences
  const idx = code.search(/[�]/);
  console.log("replacement char index:", idx);
  // print region around the @Module decorator transform
  const m = code.indexOf("Module");
  console.log("--- around 'Module' ---");
  console.log(JSON.stringify(code.slice(Math.max(0,m-100), m+300)));
} catch(e){ console.log("TRANSFORM ERR:", e.name, e.message); console.log(e.stack?.split("\n").slice(0,6).join("\n")); }
await server.close();
