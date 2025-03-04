const { createCanvas, Image } = require('canvas');
const JsBarcode = require('jsbarcode');
const bwipjs = require('bwip-js');
const { PDFDocument } = require('pdf-lib');
const readline = require('readline');

function dotsToPixels(dots, properties = {}) {

    let { printerDPI, screenDPI, scaleFactor } = { printerDPI: 203, screenDPI: 96, scaleFactor: 1.5 }

    printerDPI = 'printerDPI' in properties ? properties.printerDPI : printerDPI;
    screenDPI = 'screenDPI' in properties ? properties.screenDPI : screenDPI;
    scaleFactor = 'scaleFactor' in properties ? properties.scaleFactor : scaleFactor;

    return Math.ceil(dots * (screenDPI / printerDPI) * scaleFactor);
}

function parse2dBarcodeParameters(row, start, end) {

    const bwip_js_parameters_map = {
        's': 'securitylevel',
        'f': 'position',
        'x': 'scaleX',
        'y': 'scaleY',
        'r': 'rows',
        'l': 'columns',
        't': 'truncate',
        'o': 'orientation'
    };
    const parsedCommands = {};

    for (let i = start; i <= end - 1; i++) {
        const command = row[i].charAt(0);
        let value = parseInt(row[i].slice(1), 10);
        const parsedKey = bwip_js_parameters_map[command];
        if (!parsedKey) {
            console.error('Invalid 2D barcode parameter: `' + command + '`');
            break;
        }

        if(parsedKey === 'rows') {

            value = 40;
        }

        parsedCommands[parsedKey] = value;
    }

    return parsedCommands;
}

async function readEPLFromStdin() {

    return new Promise((resolve) => {

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });
        
        let base64String = '';
        
        rl.on('line', (line) => {
            base64String += line;
        });
        
        rl.on('close', () => {

            resolve(Buffer.from(base64String, 'base64').toString('utf8'));
        });    
    })
}

async function parseEPL() {

    const file = (await readEPLFromStdin()).split('\n');

    const commands = [];
    file.forEach(row => {
        const columns = row.trim().split(',');

        const match = columns[0].match(/^([A-Za-z]+)([A-Za-z]*)(\d*)$/);
        if (!match) {

            return;
        }
        const command = match[1];

        const left = parseInt(match[3], 10);
        if (isNaN(left)) return;

        let font = 0;
        let background = false;
        let padding = null;
        let color = 'black';
        let box = false;
        let bold = false;
        let rot = 0;
        let scaler = false;

        switch (command) {
            case 'LO':
                background = 'black';
                break;
            case 'GW':
                box = true;
                columns[2] *= 8;
                background = 'black';
                break;
        }

        switch (command.charAt(0)) {
            case 'b':
                const xBarcode = dotsToPixels(left);
                const yBarcode = dotsToPixels(columns[1]);
                const value = columns[columns.length - 1].replace(/"/g, '');
                if (columns[2] !== 'P') {
                    console.error('Unhandled 2D Barcode type: `' + columns[2] + '`. Expected `P`.');
                }
                const barcodeParams = parse2dBarcodeParameters(columns, 5, columns.length - 1);
                barcodeParams.text = value;
                barcodeParams.scaleX = dotsToPixels(barcodeParams.scaleX, { scaleFactor: 1 });
                barcodeParams.scaleY = dotsToPixels(barcodeParams.scaleY, { scaleFactor: 1 });
                rot = barcodeParams.orientation;
                switch (rot) {
                    case 1: rot = 90; break;
                    case 2: rot = 180; break;
                    case 3: rot = 270; break;
                    default: rot = 0;
                };
                commands.push({
                    type: '2d-barcode',
                    x: xBarcode,
                    y: yBarcode,
                    rot: rot,
                    params: barcodeParams
                });
                break;
            case 'B':
                const barcodeValue = columns[8].replace(/"/g, '');
                const barcodeParams2 = {
                    format: columns[3] === '1' ? 'CODE128' : 'Unknown',
                    width: dotsToPixels(columns[4], { scaleFactor: 1 }),
                    height: dotsToPixels(columns[6], { scaleFactor: 1 }),
                    displayValue: columns[7] === 'B',
                    margin: 0,
                    textAlign: 'left',                            
                };
                rot = columns[2] === '3' ? -90 : 0;
                commands.push({
                    type: 'barcode',
                    x: dotsToPixels(left),
                    y: dotsToPixels(columns[1]),
                    rot: rot,
                    value: barcodeValue,
                    params: barcodeParams2
                });
                break;
            case 'A':
                const text = columns.slice(7).join(', ').replace(/"/g, '');
                if (columns[6] === 'R') {
                    background = "black";
                    color = "white";
                    padding = 2;
                }

                scaler = 1;

                switch (parseInt(columns[3], 10)) {
                    case 1: font = 16; break;
                    case 2: font = 20; break;
                    case 3: font = 23; break;
                    case 4: scaler = 0.93; font = 28; bold = true; break;
                    case 5: font = 58; bold = true; break;
                    default: font = 96; break;
                }

                rot = columns[2] === '3' ? -90 : 0;
                commands.push({
                    type: 'text',
                    x: dotsToPixels(left),
                    y: dotsToPixels(columns[1]),
                    text: text,
                    font: dotsToPixels(font),
                    color: color,
                    bold: bold,
                    rot: rot,
                    background: background,
                    padding: padding,
                    scalerX: scaler * parseInt(columns[4]),
                    scalerY: scaler * parseInt(columns[5])
                });
                break;
            case 'L':
                commands.push({
                    type: 'box',
                    x: dotsToPixels(left),
                    y: dotsToPixels(columns[1]),
                    height: dotsToPixels(columns[3]),
                    width: dotsToPixels(columns[2]),
                    background: 'black'
                });
                break;
            case 'X':
                const xStart = left;
                const yStart = parseInt(columns[1]);
                const xEnd = parseInt(columns[3], 10);
                const yEnd = parseInt(columns[4], 10);
                const borderThickness = dotsToPixels(parseInt(columns[2], 10));
                const xMin = dotsToPixels(Math.min(xStart, xEnd));
                const yMin = dotsToPixels(Math.min(yStart, yEnd));
                const widthX = dotsToPixels(Math.max(xStart, xEnd)) - xMin;
                const heightX = dotsToPixels(Math.max(yStart, yEnd)) - yMin;
                commands.push({
                    type: 'border',
                    x: xMin,
                    y: yMin,
                    width: widthX,
                    height: heightX,
                    border_thickness: borderThickness
                });
                break;
        }
    });
    return commands;
}

function drawRect(ctx, x, y, width, height, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
}

function drawText(ctx, { text, x, y, font, color, bold, rot, background, padding, scalerX, scalerY }) {

    const textCanvas = createCanvas(ctx.canvas.width, ctx.canvas.height);
    const textCtx = textCanvas.getContext('2d');

    textCtx.font = `${bold ? 'bold ' : ''}${font * scalerX}px Courier`;
    textCtx.fillStyle = color;

    const textOffsetX = rot != 0 ? font * scalerX * 0.8 : 0;
    const textOffsetY = rot == 0 ? font * scalerX * 0.8 : 0;

    textCtx.translate(x + textOffsetX, y + textOffsetY);

    textCtx.rotate(rot * Math.PI / 180);

    textCtx.fillText(text, 0, 0);

    if (background) {
        const bgX = x - padding;
        const bgY = y - padding;
        const bgWidth = textCtx.measureText(text).width + padding;
        const bgHeight = (font * scalerX * 0.8) + padding;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot * Math.PI / 180);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, bgWidth, bgHeight);
        ctx.restore();
    }

    // if the text is being write over a black pixel, then we will change this color to white programatically
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const textImageData = textCtx.getImageData(0, 0, textCanvas.width, textCanvas.height);
    const data = imageData.data;
    const textData = textImageData.data;

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (r === 0 && g === 0 && b === 0 && a === 255) {
            textData[i] = 255;
            textData[i + 1] = 255;
            textData[i + 2] = 255;
        }
    }

    textCtx.putImageData(textImageData, 0, 0);

    ctx.drawImage(textCanvas, 0, 0);
}

function drawBarcode(ctx, x, y, value, params, rot) {
    const barcodeCanvas = createCanvas(1, 1);
    JsBarcode(barcodeCanvas, value, params);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(barcodeCanvas, 0, 0);
    ctx.restore();
}

function draw2DBarcode(ctx, x, y, params, rot) {

    return new Promise((resolve, reject) => {

        bwipjs.toBuffer({
            bcid: 'pdf417',       // Barcode type
            includetext: false,   // Don't include the human-readable text
            height: 10,           // Set the height of the barcode
            padding: 0,           // No padding
            ...params             // Spread the parsed parameters
        }, (err, png) => {

            if (err) {
                console.error('Error generating 2D barcode:', err);

                return reject(err);
            }
    
            // Create an Image from the buffer
            const img = new Image();
            img.src = png;
    
            // Draw the barcode on the canvas
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rot * Math.PI / 180);
            ctx.drawImage(img, 0, 0);
            ctx.restore();

            resolve();
        });
    })
}

function filterAndExclude(array, callback) {

    let filteredArray = [];

    for (let i = array.length - 1; i >= 0; i--) {
        if (callback(array[i])) {

            filteredArray.push(array[i]);
            array.splice(i, 1);
        }
    }

    return filteredArray;
}

async function renderCommand(ctx, command) {

    switch (command.type) {
        case 'box':
            drawRect(ctx, command.x, command.y, command.width, command.height, command.background);
            break;
        case 'border':
            ctx.strokeStyle = 'black';
            ctx.lineWidth = command.border_thickness;
            ctx.strokeRect(command.x, command.y, command.width, command.height);
            break;
        case 'text':
            drawText(ctx, command);
            break;
        case 'barcode':
            drawBarcode(ctx, command.x, command.y, command.value, command.params, command.rot);
            break;
        case '2d-barcode':
            await draw2DBarcode(ctx, command.x, command.y, command.params, command.rot);
            break;
    }
}

async function renderAllCommands(ctx, commands) {

    for (let command of commands) {
        await renderCommand(ctx, command);
    }
}

async function main() {

    // Main execution
    const canvas = createCanvas(565, 565);
    const ctx = canvas.getContext('2d');
    const commands = await parseEPL();

    // Sort and render commands based on type
    const boxes = filterAndExclude(commands, (command) => command.type == 'box');
    const border = filterAndExclude(commands, (command) => command.type == 'border');

    await renderAllCommands(ctx, boxes);
    await renderAllCommands(ctx, border);
    await renderAllCommands(ctx, commands);

    const pngBuffer = canvas.toBuffer('image/png');

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([canvas.width, canvas.height]);
    const pngImage = await pdfDoc.embedPng(pngBuffer);
    page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
    });

    const pdfBytes = await pdfDoc.save();

    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
    console.log(pdfBase64);
}

main();
