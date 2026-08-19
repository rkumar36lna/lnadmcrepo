"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument } = require("pdf-lib");
const SapCfAxios = require("sap-cf-axios").default;
const url = require("url");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 8080;

// ==================== CONFIGURATION ====================
const CONFIG = {
  destination: "DMS_DMC_DESTINATION",
  tempDir: path.join(__dirname, "temp"),
  maxFileSize: 50 * 1024 * 1024,
  allowedOrigins: [
    "https://mladmcdev.execution.us20-quality.web.dmc.cloud.sap"
  ]
};

// ==================== CORS MIDDLEWARE ====================
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CONFIG.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ==================== SAP CF AXIOS ====================
const axios = SapCfAxios(CONFIG.destination);

// ==================== EXPRESS CONFIG ====================
app.use(express.json({ limit: "1mb" }));

// ==================== MULTER CONFIG ====================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.maxFileSize }
});

// ==================== HELPERS ====================

const extractParamsFromUrl = (fullUrl) => {
  try {
    const parsedUrl = new URL(fullUrl);
    const params = {};
    parsedUrl.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return {
      path: parsedUrl.pathname || "",
      query: params
    };
  } catch (error) {
    console.error(`Error parsing URL: ${error.message}`);
    return null;
  }
};

const getExtension = (fileName) => {
  if (!fileName) return null;
  return path.extname(fileName).toLowerCase();
};

const extensionFromMimeType = (contentType) => {
  if (!contentType) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const mimeMap = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png"
  };
  return mimeMap[mime] || null;
};

const isSupportedExtension = (extension) => {
  return [
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".jpg", ".jpeg", ".png"
  ].includes(extension);
};

// ==================== IMAGE TO PDF ====================

async function imageToPdf(buffer, extension) {
  console.log(`Converting image ${extension} to PDF using pdf-lib`);
  const pdfDoc = await PDFDocument.create();
  let image;
  if (extension === ".jpg" || extension === ".jpeg") {
    image = await pdfDoc.embedJpg(buffer);
  } else if (extension === ".png") {
    image = await pdfDoc.embedPng(buffer);
  } else {
    throw new Error(`Unsupported image format: ${extension}`);
  }
  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ==================== OFFICE TO PDF ====================

async function officeToPdf(buffer, originalName, extension) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "office-converter-"));
  try {
    const inputPath = path.join(tempDir, originalName);
    await fs.writeFile(inputPath, buffer);
    const profileDir = path.join(tempDir, "lo-profile");
    await fs.mkdir(profileDir, { recursive: true });
    const profileUrl = `file://${profileDir}`;
    console.log(`Starting LibreOffice conversion: ${originalName}`);
    const result = await execFileAsync(
      "soffice",
      [
        "--headless",
        `-env:UserInstallation=${profileUrl}`,
        "--convert-to", "pdf",
        "--outdir", tempDir,
        inputPath
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );
    if (result.stdout) console.log("LibreOffice stdout:", result.stdout);
    if (result.stderr) console.log("LibreOffice stderr:", result.stderr);
    const pdfName = path.basename(originalName, extension) + ".pdf";
    const pdfPath = path.join(tempDir, pdfName);
    await fs.access(pdfPath);
    const pdfBuffer = await fs.readFile(pdfPath);
    console.log(`PDF generated successfully: ${pdfName}`);
    console.log(`PDF size: ${pdfBuffer.length} bytes`);
    return { buffer: pdfBuffer, fileName: pdfName };
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }
  }
}

// ==================== SEND PDF ====================

function sendPdf(res, pdfBuffer, fileName) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.send(pdfBuffer);
}

// ==================== ENDPOINTS ====================

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "UP", service: "DM_DMS_PDF_CONVERTOR" });
});

// Convert - Direct file upload
app.post("/convert", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const originalName = path.basename(req.file.originalname);
    const extension = getExtension(originalName);
    if (!extension || !isSupportedExtension(extension)) {
      return res.status(415).json({ error: `Unsupported file type: ${extension}` });
    }
    console.log(`Received file: ${originalName}`);
    if (extension === ".pdf") {
      return sendPdf(res, req.file.buffer, originalName);
    }
    if ([".jpg", ".jpeg", ".png"].includes(extension)) {
      const pdfBuffer = await imageToPdf(req.file.buffer, extension);
      const pdfName = path.basename(originalName, extension) + ".pdf";
      return sendPdf(res, pdfBuffer, pdfName);
    }
    const result = await officeToPdf(req.file.buffer, originalName, extension);
    return sendPdf(res, result.buffer, result.fileName);
  } catch (error) {
    console.error("Conversion error:", error);
    return res.status(500).json({ error: "Conversion failed", details: error.message });
  }
});

// Preview - Download from DMS and convert
app.post("/preview", async (req, res) => {
  try {
    const { dmsUrl } = req.body;
    if (!dmsUrl) {
      return res.status(400).json({ error: "dmsUrl is required" });
    }
    console.log(`DMS URL: ${dmsUrl}`);
    const extracted = extractParamsFromUrl(dmsUrl);
    if (!extracted) {
      return res.status(400).json({ error: "Invalid DMS URL" });
    }
    const { path: dmsPath, query } = extracted;
    if (!query.ObjectId || !query.cmisaction) {
      return res.status(400).json({ error: "Missing required parameters" });
    }
    console.log(`ObjectId: ${query.ObjectId}`);
    // Download from DMS using SAP CF Axios
    const response = await axios.get(dmsPath, {
      params: query,
      headers: { Accept: "*/*" },
      responseType: 'arraybuffer',
      timeout: 60000
    });
    const contentType = response.headers['content-type'] || '';
    const contentDisposition = response.headers['content-disposition'] || '';
    console.log(`DMS Content-Type: ${contentType}`);
    let fileName = null;
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/i);
      if (match) fileName = match[1];
    }
    if (!fileName) {
      const mimeExtension = extensionFromMimeType(contentType);
      fileName = `document${mimeExtension || ''}`;
    }
    fileName = path.basename(fileName);
    console.log(`DMS file name: ${fileName}`);
    let extension = getExtension(fileName);
    if (!extension) {
      extension = extensionFromMimeType(contentType);
    }
    console.log(`Detected extension: ${extension}`);
    const documentBuffer = Buffer.from(response.data);
    console.log(`Downloaded ${documentBuffer.length} bytes from DMS`);
    if (!extension || !isSupportedExtension(extension)) {
      return res.status(415).json({
        error: `Unsupported document type: ${contentType}`,
        detectedExtension: extension
      });
    }
    if (extension === ".pdf") {
      console.log("Document is already PDF. Returning without conversion.");
      return sendPdf(res, documentBuffer, fileName);
    }
    if ([".jpg", ".jpeg", ".png"].includes(extension)) {
      console.log("Image detected. Converting using pdf-lib.");
      const pdfBuffer = await imageToPdf(documentBuffer, extension);
      const pdfName = path.basename(fileName, extension) + ".pdf";
      return sendPdf(res, pdfBuffer, pdfName);
    }
    console.log("Office document detected. Converting using LibreOffice...");
    const result = await officeToPdf(documentBuffer, fileName, extension);
    return sendPdf(res, result.buffer, result.fileName);
  } catch (error) {
    console.error("Preview error:", error);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${error.response.data}`);
    }
    return res.status(500).json({
      error: "DMS preview failed",
      details: error.message,
      status: error.response?.status || 500
    });
  }
});

// Root - Documentation
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>DM_DMS_PDF_CONVERTOR</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
          h1 { color: #0078d4; }
          .endpoint { background: #f5f5f5; padding: 12px 16px; border-radius: 4px; margin: 8px 0; }
          .endpoint code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
          .supported { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin: 2px; background: #e8f4fd; color: #005a9e; }
        </style>
      </head>
      <body>
        <h1>📄 DM_DMS_PDF_CONVERTOR</h1>
        <p>Document to PDF Converter with LibreOffice</p>
        <h2>Supported Formats:</h2>
        <p>
          <span class="supported">PDF</span>
          <span class="supported">DOC</span>
          <span class="supported">DOCX</span>
          <span class="supported">XLS</span>
          <span class="supported">XLSX</span>
          <span class="supported">PPT</span>
          <span class="supported">PPTX</span>
          <span class="supported">JPG</span>
          <span class="supported">PNG</span>
        </p>
        <h2>Endpoints:</h2>
        <div class="endpoint">
          <strong>POST /convert</strong><br>
          <code>multipart/form-data with 'file' field</code><br>
          <small>Upload a document and receive PDF</small>
        </div>
        <div class="endpoint">
          <strong>POST /preview</strong><br>
          <code>{ "dmsUrl": "https://..." }</code><br>
          <small>Download from DMS and convert to PDF</small>
        </div>
        <div class="endpoint">
          <strong>GET /health</strong><br>
          <code>/health</code><br>
          <small>Health check</small>
        </div>
      </body>
    </html>
  `);
});

// ==================== START SERVER ====================
app.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(`🚀 DM_DMS_PDF_CONVERTOR started on port ${PORT}`);
  console.log(`📡 Destination: ${CONFIG.destination}`);
  console.log(`📄 Supported: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, JPG, PNG`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log("============================================");
});

module.exports = app;
