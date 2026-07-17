#!/usr/bin/env python3
"""Build the compact browser dictionary used by the lyrics-explains plugin."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
import unicodedata
import urllib.request
from pathlib import Path
from typing import Any

REPOSITORY = "scriptin/jmdict-simplified"
LATEST_RELEASE_API = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
DEFAULT_OUTPUT = Path(__file__).with_name("jmdict-eng-common.json")
USER_AGENT = "MusicCloud-plugin-examples dictionary builder"


def request_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response:
        return response.read()


def download_source() -> tuple[dict[str, Any], dict[str, str]]:
    release = json.loads(request_bytes(LATEST_RELEASE_API))
    asset = next(
        asset
        for asset in release["assets"]
        if asset["name"].startswith("jmdict-eng-common-")
        and asset["name"].endswith(".json.tgz")
    )
    archive = request_bytes(asset["browser_download_url"])
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        member = next(member for member in tar.getmembers() if member.name.endswith(".json"))
        source_file = tar.extractfile(member)
        if source_file is None:
            raise RuntimeError(f"Unable to read {member.name} from the source archive")
        source = json.load(source_file)
    metadata = {
        "release": release["tag_name"],
        "archive": asset["name"],
        "archiveUrl": asset["browser_download_url"],
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
    }
    return source, metadata


def read_source(path: Path) -> tuple[dict[str, Any], dict[str, str]]:
    source = json.loads(path.read_text(encoding="utf-8"))
    return source, {
        "release": "local-input",
        "archive": path.name,
        "archiveUrl": "",
        "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def compact(source: dict[str, Any], source_metadata: dict[str, str]) -> dict[str, Any]:
    if not source.get("commonOnly"):
        raise ValueError("Expected a jmdict-eng-common source dictionary")

    entries: list[list[Any]] = []
    used_pos: set[str] = set()
    for word in source["words"]:
        senses: list[list[Any]] = []
        for sense in word["sense"]:
            glosses = [
                gloss["text"]
                for gloss in sense["gloss"]
                if gloss.get("lang") == "eng" and gloss.get("text")
            ]
            if not glosses:
                continue
            part_of_speech = sense["partOfSpeech"]
            used_pos.update(part_of_speech)
            senses.append([part_of_speech, glosses])
        if not senses:
            continue
        entries.append(
            [
                word["id"],
                [[form["text"], 1 if form["common"] else 0] for form in word["kanji"]],
                [[form["text"], 1 if form["common"] else 0] for form in word["kana"]],
                senses,
            ]
        )

    lookup: dict[str, list[int]] = {}
    for entry_index, entry in enumerate(entries):
        for form, _common in [*entry[1], *entry[2]]:
            normalized = "".join(
                chr(ord(character) - 0x60)
                if "ァ" <= character <= "ヶ"
                else character
                for character in unicodedata.normalize("NFKC", form).lower()
            )
            indexes = lookup.setdefault(normalized, [])
            if entry_index not in indexes:
                indexes.append(entry_index)

    tags = source["tags"]
    return {
        "format": 2,
        "source": {
            "name": "JMdict",
            "dictionaryDate": source["dictDate"],
            "dictionaryRevision": source["dictRevisions"],
            "jmdictSimplifiedVersion": source["version"],
            "commonOnly": True,
            "license": "CC BY-SA 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
            "attribution": "JMdict/EDRDG, converted by scriptin/jmdict-simplified",
            **source_metadata,
        },
        "partOfSpeech": {tag: tags[tag] for tag in sorted(used_pos)},
        "lookup": lookup,
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, help="Use an extracted jmdict-eng-common JSON file")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source, metadata = read_source(args.input) if args.input else download_source()
    result = compact(source, metadata)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(result['entries'])} entries to {args.output} "
        f"({args.output.stat().st_size} bytes)"
    )


if __name__ == "__main__":
    main()
