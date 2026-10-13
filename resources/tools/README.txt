manifest.exe - patched build of meszmate/manifest v0.1.0

What changed
  The original tool assumes every chunk on Epic's CDN is zlib-compressed.
  Chunks that Epic stored uncompressed (data that does not compress well)
  failed with:  "decompress: zlib init: zlib: invalid header"
  This build reads each chunk's header and handles both kinds.

Nothing else is different. The exact source change is in plain-chunk-fix.patch.
Original project (MIT licence): https://github.com/meszmate/manifest

How to use
  Put manifest.exe in a folder and run the same commands as before.
  Use the same --output folder as your earlier attempt: chunks already
  downloaded are kept, and only the ones that failed are fetched.
