const puppeteer = require('puppeteer');

(async () => {
   const browser = await puppeteer.launch({headless: "new"});
   const page = await browser.newPage();
   await page.setViewport({
      width: 2560,
      height: 1440,
    });       
   await page.goto(
      'http://localhost:4000/gallery/random',
      { waitUntil: 'domcontentloaded' },
   );
   var path = require('path');
   const client = await page.target().createCDPSession();
   await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(),
   });

   console.log('Start downloading');

   await page.click('[id="downloadbox"]');
   await page.waitForTimeout(5000);

   console.log('Complete');
   await browser.close();
})();