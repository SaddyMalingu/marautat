// Copy the logo image to the public directory for web access
const fs = require('fs');
const path = require('path');

const src = 'C:/Users/I.A Journal hub/Downloads/Untitled design (4).png';
const dest = path.join(__dirname, 'public', 'brand-logo.png');

fs.copyFileSync(src, dest);
console.log('Logo image copied to public/brand-logo.png');
