# Third-party notices

SoloPDF bundles the following third-party components.

## pdf.js — Apache-2.0
Mozilla's PDF renderer. https://github.com/mozilla/pdf.js

## CC-CEDICT — CC BY-SA 4.0
The bundled offline Chinese↔English dictionary in `app/public/dict/` is built
from CC-CEDICT. https://www.mdbg.net/chinese/dictionary?page=cc-cedict
Rebuild it with `node scripts/build-dict.mjs <cedict_ts.u8>`.

## node-unrar-js / UnRAR — MIT wrapper around the UnRAR sources
Used to read `.cbr` comic archives. The UnRAR sources may be freely
distributed and used to *read* RAR archives; they may not be used to develop
a RAR (WinRAR) compatible archiver. SoloPDF only ever reads.
https://github.com/YuJianrong/node-unrar.js

## djvu-rs — MIT
Pure-Rust DjVu decoding. Chosen over the reference DjVuLibre, which is GPL
and cannot ship in the Mac App Store build.
https://github.com/matyushkin/djvu-rs

## GlyphLessFont — Apache-2.0
The invisible font used for the OCR text layer, from Tesseract.
https://github.com/tesseract-ocr/tesseract

## PP-OCRv4 / v6 models — Apache-2.0
Bundled OCR models on Windows and Linux. https://github.com/PaddlePaddle/PaddleOCR

## UTIF.js (utif2) — MIT
Pure-JS TIFF decoding (CCITT G3/G4 fax, LZW, PackBits, Deflate, JPEG) for
`.tif` / `.tiff` pages, in the app and in the CLI's `to-images`.
Copyright (c) 2017 Photopea. https://github.com/photopea/UTIF.js

## pako — MIT (+ zlib license)
Deflate decompression used by UTIF.js for Deflate-compressed TIFF strips.
https://github.com/nodeca/pako

## fflate — MIT
ZIP/gzip handling for EPUB, CBZ, zipped FB2 (.fbz / .fb2.zip) and the
dictionary shards.
https://github.com/101arrowz/fflate

## lopdf — MIT
PDF writing (page operations, annotations, signatures, encryption).
https://github.com/J-F-Liu/lopdf
