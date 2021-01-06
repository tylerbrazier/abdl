#!/usr/bin/env node

// Audio Bible Downloader
// The bible api can be figured out by watching the network traffic of bible.com

const path = require('path');
const https = require('https');
const fs = require('fs');

let bookListCache = null
const defaultTranslationId = 100

main(); // no toplevel await :(

async function main() {
  try {
    const {
      help,
      listTranslations,
      listBooks,
      translationId,
      canonical,
      bookId,
      chapters,
    } = await getArgs();

    if (help) {
      printHelp();
    }

    if (listTranslations) {
      await printTranslations();
    }

    // need to validate translationId before attempting to call printBookList()
    if (isNaN(translationId)) {
      printHelp(console.error);
      throw Error('Invalid translation id: ' + translationId);
    }

    if (listBooks) {
      await printBookList(translationId);
    }

    if (help || listTranslations || listBooks) {
      process.exit();
    }

    if (!bookId) {
      printHelp(console.error);
      throw Error('book id required');
    }

    const [ start, end ] = await getChapterRange(translationId, bookId, chapters);

    const dirname = await mkdir(translationId, bookId, canonical);

    console.log(`Downloading chapters ${start}-${end}`);
    let audioUrl, chapterName, outputPath, data;
    for (let c = start; c <= end; c++) {
      ({ audioUrl, chapterName } = await fetchMetadata(translationId, bookId, c));
      outputPath = getOutputFilePath(dirname, chapterName);
      data = await download(audioUrl);

      console.log('Writing to ' + outputPath);
      await fs.promises.writeFile(outputPath, data);
    }
    console.log('It is finished');

  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

async function getArgs() {
  const result = {
    help: false,
    listBooks: false,
    listTranslations: false,
    canonical: false,
    translationId: defaultTranslationId,
    chapters: null,
    bookId: null,
  }
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '-h') {
      result.help = true;
    } else if (arg === '-l') {
      result.listBooks = true;
    } else if (arg === '-i') {
      result.listTranslations = true;
    } else if (arg === '-c') {
      result.canonical = true;
    } else if (arg === '-t') {
      result.translationId = process.argv[i + 1];
      i++;
    } else if (arg.startsWith('-t')) {
      result.translationId = arg.replace('-t', '');
    } else if (result.bookId) {
      result.chapters = arg;
    } else {
      result.bookId = arg.toUpperCase();
    }
  }
  return result;
}

async function fetchBookList(translationId) {
  if (bookListCache) return bookListCache;
  console.log('Fetching books');
  const url = "https://www.bible.com/json/bible/books/" + translationId;
  const json = await fetchJson(url);
  validateResponseHasItems(json);
  bookListCache = json.items;
  return bookListCache;
}

async function printBookList(translationId, logFn = console.log) {
  (await fetchBookList(translationId))
    .forEach(item => logFn(`${item.usfm}:\t${item.human}`));
}

async function fetchTranslations() {
  console.log("Fetching translations");
  const url = "https://www.bible.com/json/bible/versions/eng";
  const json = await fetchJson(url);
  validateResponseHasItems(json);
  return json.items;
}

async function printTranslations(logFn = console.log) {
  (await fetchTranslations())
    .filter(item => item.audio)
    .forEach(item => logFn(`${item.id}:\t${item.local_title}`));
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200) resolve(parsed);
          else reject(parsed);
        } catch (err) {
          reject(err);
        }
      })
    }).on('error', reject);
  })
}

// returns the name of the created dir
async function mkdir(translationId, bookId, canonical) {
  // get the 'human' name for the book
  const items = await fetchBookList(translationId);
  const index = items.findIndex(item => item.usfm === bookId);
  if (index < 0) {
    await printBookList(translationId, console.error);
    throw Error('Did not find book id: ' + bookId);
  }
  let dirname = items[index].human.replace(/\s+/g, '_');
  if (canonical) {
    // precede directory book names with their canonical number e.g. 02-Exodus
    dirname = `${String(index+1).padStart(2, '0')}-${dirname}`;
  }
  console.log('Making directory ' + dirname)
  await fs.promises.mkdir(dirname, { recursive: true });
  return dirname;
}

async function fetchMetadata(translationId, bookId, chapter) {
  // e.g. https://nodejs.bible.com/api/bible/chapter/3.1?id=100&reference=PSA.25
  const metaUrl = 'https://nodejs.bible.com/api/bible/chapter/3.1?' +
    `id=${translationId}&reference=${bookId}.${chapter}`;
  console.log(`Fetching metadata for ${bookId}.${chapter}`);
  const json = await fetchJson(metaUrl);
  validateMetadataResponse(json);
  const chapterName = json.reference.human;
  let audioUrl = json.audio[0].download_urls.format_mp3_32k;
  audioUrl = audioUrl.startsWith('//') ? ('https:' + audioUrl) : audioUrl;
  return { audioUrl, chapterName };
}

// It would be better to stream the download directly to the output file rather
// than buffering it but the handling all the events and possible errors makes
// for really messy and unpredictable code.
async function download(url) {
  console.log('Downloading ' + url);
  return new Promise((resolve, reject) => {
    const req = https.get(url, resp => {
      const respMessage = `${resp.statusCode} ${resp.statusMessage}`;

      if (resp.statusCode !== 200) {
        resp.resume(); // Consume response data to free up memory
        return reject(Error(respMessage));
      }

      console.log(respMessage);
      const dataBuffer = [];
      resp.on('data', data => dataBuffer.push(data));
      resp.on('end', () => resolve(Buffer.concat(dataBuffer)));
    });

    req.on('error', reject);
  });
}

async function getChapterRange(translationId, bookId, chapterArg) {
  // if no chapters are specified by the user, get all of them
  if (!chapterArg) {
    console.log('Fetching chapters for ' + bookId);
    const url = `https://www.bible.com/json/bible/books/${translationId}/${bookId}/chapters`;
    const json = await fetchJson(url);
    validateResponseHasItems(json);
    return [ 1, json.items.length ];
  }

  if (!chapterArg.match(/^\d+(-\d+)?$/)) {
    throw Error('Chapter must be a number or a range (e.g. 3-5)');
  }
  const result = chapterArg.split('-').map(Number)
  if (result[1] && (result[1] <= result[0])) {
    throw Error('Invalid range: ' + chapterArg);
  }
  result[1] = result[1] || result[0]; // if end isn't given, use start as end
  return result;
}

function validateMetadataResponse(json) {
  if (
    !Array.isArray(json.audio) ||
    !json.audio.length ||
    !json.audio[0].download_urls ||
    !json.audio[0].download_urls.format_mp3_32k ||
    !json.reference ||
    !json.reference.human
  ) {
    throw Error('Unexpected response:\n' + JSON.stringify(json, null, 2));
  }
}

function validateResponseHasItems(json) {
  if (!Array.isArray(json.items)) {
    throw Error('Unexpected response:\n' + JSON.stringify(json, null, 2));
  }
}

function getOutputFilePath(dirname, chapterName) {
  return path.join(dirname, chapterName.replace(/\s+/g, '_') + '.mp3');
}

function printHelp(logFn = console.log) {
  const thisfile = path.basename(__filename);
  logFn('Download audio bible files into the current directory.');
  logFn(`Usage: node ${thisfile} [options] <book id> [chapter(s)]`);
  logFn('\t-h  help');
  logFn('\t-l  list books ids');
  logFn('\t-i  list translation ids');
  logFn(`\t-t  use translation id (default ${defaultTranslationId})`);
  logFn(`\t-c  precede directory book names with their canonical number`);
  logFn(`e.g. node ${thisfile} -t100 PSA 27-34`);
  logFn('If no chapters are specified, all of them will be downloaded.');
}
