# Dictionary data notice

`jmdict-eng-common.json` is a compact derivative of the English common-word
subset published by [jmdict-simplified](https://github.com/scriptin/jmdict-simplified),
which is generated from the [JMdict](https://www.edrdg.org/jmdict/j_jmdict.html)
dictionary maintained by the Electronic Dictionary Research and Development
Group (EDRDG).

The dictionary data and this derived JSON file are distributed under the
[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)
license. The JSON metadata records the exact upstream release, archive URL and
SHA-256 checksum used to generate it.

Run `python3 plugins/lyrics-explains/data/build_jmdict.py` from the repository
root to refresh the data from the latest jmdict-simplified release.

The runtime tokenizer is [kuromoji.js](https://github.com/takuyaa/kuromoji.js)
(Apache-2.0) and loads its bundled MeCab IPADIC files from jsDelivr. See the
kuromoji.js [`NOTICE.md`](https://github.com/takuyaa/kuromoji.js/blob/master/NOTICE.md)
for the IPADIC copyright and redistribution notices.
