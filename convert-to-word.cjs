const fs = require('fs');
const { marked } = require('marked');
const htmlDocx = require('html-docx-js');

// Read the markdown file
const markdown = fs.readFileSync('ClassPilot_IT_Tutorial.md', 'utf8');

// Convert markdown to HTML
const html = marked(markdown);

// Wrap in a proper HTML document with styling
const styledHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: Calibri, Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      color: #2563eb;
      border-bottom: 3px solid #2563eb;
      padding-bottom: 10px;
    }
    h2 {
      color: #1e40af;
      margin-top: 30px;
      border-bottom: 2px solid #93c5fd;
      padding-bottom: 5px;
    }
    h3 {
      color: #1e3a8a;
      margin-top: 20px;
    }
    code {
      background-color: #f3f4f6;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    pre {
      background-color: #f3f4f6;
      padding: 15px;
      border-radius: 5px;
      overflow-x: auto;
    }
    pre code {
      background-color: transparent;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #2563eb;
      padding-left: 15px;
      margin-left: 0;
      color: #4b5563;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 15px 0;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 8px;
      text-align: left;
    }
    th {
      background-color: #2563eb;
      color: white;
    }
    ul, ol {
      margin: 10px 0;
    }
    li {
      margin: 5px 0;
    }
  </style>
</head>
<body>
${html}
</body>
</html>
`;

// Convert HTML to Word document using arrayBuffer method
async function generateDoc() {
  const docx = htmlDocx.asBlob(styledHtml);
  const arrayBuffer = await docx.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  // Write to file
  fs.writeFileSync('ClassPilot_IT_Tutorial.docx', buffer);
  
  console.log('✅ Word document created successfully: ClassPilot_IT_Tutorial.docx');
  console.log('📄 You can now download and open this file in Microsoft Word!');
}

generateDoc().catch(console.error);
