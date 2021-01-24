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

    const [ start, end, total ] = await getChapterRange(translationId, bookId, chapters);

    const { bookName, canonicalIndex } = await fetchBookInfo(translationId, bookId);

    const dirname = await mkdir(bookName, canonical && canonicalIndex);

    console.log(`Downloading chapters ${start}-${end}`);
    let audioUrl, outputPath, data;
    for (let c = start; c <= end; c++) {
      audioUrl = await fetchAudioUrl(translationId, bookId, c);
      outputPath = getOutputFilePath(dirname, bookName, c, total);
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
async function mkdir(bookName, canonicalIndex) {
  let dirname = bookName;
  if (canonicalIndex) {
    // precede directory book names with their canonical number e.g. 02-Exodus
    dirname = `${String(canonicalIndex).padStart(2, '0')}-${dirname}`;
  }
  console.log('Making directory ' + dirname)
  await fs.promises.mkdir(dirname, { recursive: true });
  return dirname;
}

async function fetchBookInfo(translationId, bookId) {
  const items = await fetchBookList(translationId);
  const index = items.findIndex(item => item.usfm === bookId);
  if (index < 0) {
    await printBookList(translationId, console.error);
    throw Error('Did not find book id: ' + bookId);
  }
  return {
    bookName: items[index].human.replace(/\s+/g, '_'),
    canonicalIndex: index+1,
  }
}

async function fetchAudioUrl(translationId, bookId, chapter) {
  // e.g. https://nodejs.bible.com/api/bible/chapter/3.1?id=100&reference=PSA.25
  const metaUrl = 'https://nodejs.bible.com/api/bible/chapter/3.1?' +
    `id=${translationId}&reference=${bookId}.${chapter}`;
  console.log(`Fetching metadata for ${bookId}.${chapter}`);
  const json = await fetchJson(metaUrl);
  validateMetadataResponse(json);
  const audioUrl = json.audio[0].download_urls.format_mp3_32k;
  return audioUrl.startsWith('//') ? ('https:' + audioUrl) : audioUrl;
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

// Returns an array with three entries: [ start, end, total ].
// For an input like `GEN 10-20` this would return [ 10, 20, 50 ].
async function getChapterRange(translationId, bookId, chapterArg) {
  if (chapterArg && !chapterArg.match(/^\d+(-\d+)?$/)) {
    throw Error('Chapter must be a number or a range (e.g. 3-5)');
  }

  console.log('Fetching chapters for ' + bookId);
  const url = `https://www.bible.com/json/bible/books/${translationId}/${bookId}/chapters`;
  const json = await fetchJson(url);
  validateResponseHasItems(json);
  const total = json.items.length;

  // if no chapters are specified by the user, download all of them
  if (!chapterArg) {
    return [ 1, total, total ];
  }

  const range = chapterArg.split('-').map(Number)
  if (range[1] && (range[1] <= range[0])) {
    throw Error('Invalid range: ' + chapterArg);
  }

  range[1] = range[1] || range[0]; // if end isn't given, use start as end
  return range.concat(total);
}

function validateMetadataResponse(json) {
  if (
    !Array.isArray(json.audio) ||
    !json.audio.length ||
    !json.audio[0].download_urls ||
    !json.audio[0].download_urls.format_mp3_32k
    //!json.reference ||
    //!json.reference.human
  ) {
    throw Error('Unexpected response:\n' + JSON.stringify(json, null, 2));
  }
}

function validateResponseHasItems(json) {
  if (!Array.isArray(json.items)) {
    throw Error('Unexpected response:\n' + JSON.stringify(json, null, 2));
  }
}

function getOutputFilePath(dirname, bookName, chapter, totalChapters) {
  const paddedChapter = String(chapter).padStart(String(totalChapters).length, '0');
  return path.join(dirname, `${bookName}-${paddedChapter}.mp3`);
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
