import { mdToPdf } from 'md-to-pdf';
import path from 'path';

async function generatePDF() {
  try {
    console.log('Converting CLASSPILOT_USER_GUIDE.md to PDF...');
    
    const pdf = await mdToPdf(
      { path: 'CLASSPILOT_USER_GUIDE.md' },
      {
        dest: 'CLASSPILOT_USER_GUIDE.pdf',
        launch_options: {
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ]
        },
        pdf_options: {
          format: 'A4',
          margin: {
            top: '20mm',
            right: '20mm',
            bottom: '20mm',
            left: '20mm'
          },
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<div style="font-size: 9px; text-align: center; width: 100%;"></div>',
          footerTemplate: '<div style="font-size: 9px; text-align: center; width: 100%; margin: 0 20mm;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
        },
        stylesheet: 'pdf-style.css'
      }
    );
    
    console.log('✅ PDF generated successfully: CLASSPILOT_USER_GUIDE.pdf');
    console.log(`   File size: ${(pdf.content.length / 1024).toFixed(2)} KB`);
    
  } catch (error) {
    console.error('❌ Error generating PDF:', error);
    process.exit(1);
  }
}

generatePDF();
