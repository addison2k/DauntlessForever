# SPDX-License-Identifier: AGPL-3.0-only
# Export the IDs and inventory flags used by the 1.14.7 unlock helper.
# Tagged-property layout based on the bundled Equipment1147 source reader.
# Developer tool only: players use the generated JSON with the bundled Node.js.
import argparse
import ctypes
import hashlib
import json
import re
import struct
from pathlib import Path

MAGIC = 0x5A6F12E1


ID_RE = re.compile(rb"[A-Z][A-Z0-9_]{2,80}")


INSTANCED_PREFIXES = ("WP_", "AR_", "LT_", "PART_", "BN_", "FL_", "PLAYER_ROLE_", "PR_", "ACC_", "TOY_", "PET_", "MINIPET_")


STACKED_PREFIXES = ("CELL_", "CURRENCY_", "TOKEN_", "QI_", "DYE_", "EM_", "EJ_", "BNC_", "TITLE_", "CONTAINER_", "FLARE_")


POTION_FILES = {
    "Gameplay/Backend/Catalogs/quick_item_catalog.uasset",
    "Gameplay/Backend/Catalogs/event_catalogs/quick_item_events_catalog.uasset",
    "Gameplay/Backend/Catalogs/flask_catalog.uasset",
}


CATALOG_FILES = [
    "Gameplay/Backend/Catalogs/currency_tokens_catalog.uasset",
    "Gameplay/Backend/Catalogs/flask_catalog.uasset",
    "Gameplay/Backend/Catalogs/quick_item_catalog.uasset",
    "Gameplay/Backend/Catalogs/event_catalogs/quick_item_events_catalog.uasset",
    "Gameplay/Backend/Catalogs/dyes_item_catalog.uasset",
    "Gameplay/Backend/Catalogs/flare_catalog.uasset",
    "Gameplay/Backend/Catalogs/banner_catalog.uasset",
    "Gameplay/Backend/Catalogs/banner_customization_catalog.uasset",
    "Gameplay/Backend/Catalogs/title_catalog.uasset",
    "Gameplay/Backend/Catalogs/emotes_catalog.uasset",
    "Gameplay/Backend/Catalogs/emojis_catalog.uasset",
    "Gameplay/Backend/Catalogs/toys_catalog.uasset",
    "Gameplay/Backend/Catalogs/minipet_catalog.uasset",
    "Gameplay/Backend/Catalogs/generated_cell_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/cells_v2_catalog.uasset",
    "Gameplay/Backend/Catalogs/containers_storeoffers_cores.uasset",
    "Gameplay/Backend/Catalogs/containers_core_huntpass_prestige.uasset",
    "Gameplay/Backend/Catalogs/containers_core_cellcores.uasset",
    "Gameplay/Backend/Catalogs/containers_promotion_cores.uasset",
    "Gameplay/Backend/Catalogs/promotion_bundles.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_progression_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_general_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_faction_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_unlock_quick_items_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_hunt_behemoth_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_contracts_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_unlock_exotics_catalog.uasset",
    "Gameplay/Backend/Catalogs/Token_Catalogs/tokens_unlock_weapons_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/armour_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/armour_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/lantern_gameplay_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/lantern_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_part_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/player_role_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/accessory_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_mspear_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_ihammer_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_gaxe_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_eblade_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_dp_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_cblades_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_ac_gameplay_catalog_composite.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_mspear_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_ihammer_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_gaxe_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_eblade_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_dp_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_cblades_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_ac_cosmetic_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_bow_gameplay_catalog.uasset",
    "Gameplay/Backend/Catalogs/Gear_Catalogs/weapon_bow_cosmetic_catalog.uasset",
]


TALENT_FILES = [
    "gamemodes/escalation/base_blueprints/escalation_talents.uasset",
    "gamemodes/escalation/base_blueprints/escalation_talents_S2.uasset",
    "gamemodes/escalation/base_blueprints/escalation_talents_S3.uasset",
    "gamemodes/escalation/base_blueprints/escalation_talents_S4.uasset",
    "gamemodes/escalation/base_blueprints/escalation_talents_S5.uasset",
    "gamemodes/escalation/base_blueprints/escalation_talents_S6.uasset",
]


def read_fstring(buf, pos):
    (count,) = struct.unpack_from("<i", buf, pos)
    pos += 4
    if count == 0:
        return "", pos
    if count < 0:
        count = -count
        raw = buf[pos : pos + count * 2]
        pos += count * 2
        return raw.decode("utf-16le").rstrip("\x00"), pos
    raw = buf[pos : pos + count]
    pos += count
    return raw.decode("utf-8", "replace").rstrip("\x00"), pos


def pak_footer(blob):
    tail = blob[-512:]
    idx = tail.rfind(struct.pack("<I", MAGIC))
    if idx < 0:
        raise RuntimeError("This pak has no Unreal index.")
    version, offset, size = struct.unpack_from("<Iqq", tail, idx + 4)
    methods = ["None"]
    name_at = idx + 4 + 4 + 8 + 8 + 20
    for slot in range(5):
        raw = tail[name_at + slot * 32 : name_at + (slot + 1) * 32]
        name = raw.split(b"\x00", 1)[0].decode("ascii", "ignore")
        if name:
            methods.append(name)
    return version, offset, size, methods


def decode_entry(data, offset, methods):
    pos = offset
    (bitfield,) = struct.unpack_from("<I", data, pos)
    pos += 4
    if (bitfield & 0x3F) == 0x3F:
        (block_size,) = struct.unpack_from("<I", data, pos)
        pos += 4
    else:
        block_size = (bitfield & 0x3F) << 11
    method_index = (bitfield >> 23) & 0x3F
    method = methods[method_index] if method_index < len(methods) else "Unknown"
    if bitfield & (1 << 31):
        (file_off,) = struct.unpack_from("<I", data, pos)
        pos += 4
    else:
        (file_off,) = struct.unpack_from("<Q", data, pos)
        pos += 8
    if bitfield & (1 << 30):
        (uncomp,) = struct.unpack_from("<I", data, pos)
        pos += 4
    else:
        (uncomp,) = struct.unpack_from("<Q", data, pos)
        pos += 8
    if method != "None":
        if bitfield & (1 << 29):
            (comp,) = struct.unpack_from("<I", data, pos)
            pos += 4
        else:
            (comp,) = struct.unpack_from("<Q", data, pos)
            pos += 8
    else:
        comp = uncomp
    blocks = (bitfield >> 6) & 0xFFFF
    encrypted = (bitfield & (1 << 22)) != 0
    lengths = []
    if blocks > 1 or encrypted:
        for _ in range(blocks):
            (length,) = struct.unpack_from("<I", data, pos)
            pos += 4
            lengths.append(length)
    return {
        "method": method,
        "off": file_off,
        "uncomp": uncomp,
        "comp": comp,
        "blocks": blocks,
        "block_size": block_size,
        "lengths": lengths,
    }


def load_pak(blob):
    version, index_off, index_size, methods = pak_footer(blob)
    buf = blob[index_off : index_off + index_size]
    pos = 0
    mount, pos = read_fstring(buf, pos)
    pos += 4 + 8 + 4 + 36 + 4
    dir_off, dir_size = struct.unpack_from("<qq", buf, pos)
    pos += 16 + 20
    (enc_size,) = struct.unpack_from("<i", buf, pos)
    pos += 4
    encoded = buf[pos : pos + enc_size]
    dbuf = blob[dir_off : dir_off + dir_size]
    dpos = 0
    (ndirs,) = struct.unpack_from("<i", dbuf, dpos)
    dpos += 4
    files = {}
    for _ in range(ndirs):
        folder, dpos = read_fstring(dbuf, dpos)
        (nfiles,) = struct.unpack_from("<i", dbuf, dpos)
        dpos += 4
        for _file in range(nfiles):
            fname, dpos = read_fstring(dbuf, dpos)
            (entry_off,) = struct.unpack_from("<i", dbuf, dpos)
            dpos += 4
            files[folder + fname] = entry_off
    return version, methods, encoded, files, mount


def oodle_decompress(src, size):
    lib = ctypes.WinDLL(str(OODLE))
    fn = lib.OodleLZ_Decompress
    fn.argtypes = [
        ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int64,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int,
    ]
    fn.restype = ctypes.c_int64
    out = ctypes.create_string_buffer(size)
    source = ctypes.create_string_buffer(src)
    got = fn(source, len(src), out, size, 0, 0, 0, None, 0, None, None, None, 0, 3)
    if got != size:
        raise RuntimeError(f"Oodle returned {got}, expected {size}")
    return out.raw


def extract_file(blob, encoded, methods, entry_off):
    entry = decode_entry(encoded, entry_off, methods)
    skip = 53
    if entry["method"] != "None":
        skip += 4 + max(entry["blocks"], 1) * 16
    raw = blob[entry["off"] + skip : entry["off"] + skip + entry["comp"]]
    if entry["method"] == "None":
        return raw[: entry["uncomp"]]
    if entry["blocks"] <= 1:
        return oodle_decompress(raw, entry["uncomp"])
    pieces = []
    cursor = 0
    left = entry["uncomp"]
    block_size = entry["block_size"] or entry["uncomp"]
    for length in entry["lengths"]:
        take = min(block_size, left)
        pieces.append(oodle_decompress(raw[cursor : cursor + length], take))
        cursor += length
        left -= take
    return b"".join(pieces)


def is_extra_cosmetic(catalog_id):
    # Real accessory, toy, and minipet ids. Short name-map scraps like AC_P are not items.
    if catalog_id.startswith(("AC_HEAD_", "AC_BACK_")):
        return True
    if catalog_id.startswith("TY_") and len(catalog_id) >= 10:
        return True
    if catalog_id.startswith("MP_") and len(catalog_id) >= 8:
        return True
    return False


def wanted(catalog_id):
    if catalog_id.startswith("GD_FRAME") or catalog_id == "CURRENCY_NULL_REWARD" or "PROTO" in catalog_id:
        return False
    if catalog_id.startswith("CELL_") and ("UNLOCK" in catalog_id or catalog_id.startswith(("CELL_EFFECT", "CELL_DP_"))):
        return False
    if is_extra_cosmetic(catalog_id) or catalog_id.startswith("PR_UNLOCK"):
        return True
    return catalog_id.startswith(INSTANCED_PREFIXES + STACKED_PREFIXES)


def is_instanced(catalog_id, skins=()):
    if catalog_id in skins:
        return False
    if catalog_id.startswith("PR_UNLOCK") or catalog_id.startswith("TY_"):
        return False
    if catalog_id.startswith(("AC_HEAD_", "AC_BACK_", "MP_")):
        return True
    return catalog_id.startswith(INSTANCED_PREFIXES)


def stack_qty(catalog_id, potion_ids):
    if catalog_id.startswith(("CURRENCY_", "TOKEN_")):
        return 99999
    if catalog_id.startswith("CELL_"):
        return 6
    if catalog_id in potion_ids or catalog_id.startswith("QI_"):
        if catalog_id in potion_ids or "POTION" in catalog_id or "PYLON" in catalog_id or "FLASK" in catalog_id:
            return 999
    if catalog_id.startswith("CONTAINER_"):
        return 4
    return 1


def cosmetic_catalog_ids(uasset, uexp):
    """Read actual 1.14.7 DataTable rows and their inventory classification.

    Uses the tagged-property layout described by the bundled Equipment1147
    reader (AGPL-3.0-only). Nested property payloads are skipped by tag size.
    Unsupported layouts fail before any save is changed.
    """
    if uasset[:4] != bytes.fromhex("c1832a9e") or struct.unpack_from("<i", uasset, 4)[0] != -7:
        raise ValueError("Unsupported cosmetic asset header")
    if struct.unpack_from("<I", uasset, 20)[0] != 0:
        raise ValueError("Unsupported asset custom versions")
    _, pos = read_fstring(uasset, 28)
    count, offset = struct.unpack_from("<II", uasset, pos + 4)
    names = []
    for _ in range(count):
        name, offset = read_fstring(uasset, offset)
        names.append(name)
        offset += 4

    def name_at(pos):
        index, number = struct.unpack_from("<II", uexp, pos)
        if index >= len(names):
            raise ValueError("Invalid cosmetic property name")
        return names[index] + ("_" + str(number - 1) if number else ""), pos + 8

    def properties(pos, limit):
        values = {}
        while pos < limit:
            key, pos = name_at(pos)
            if key == "None":
                return pos, values
            kind, pos = name_at(pos)
            size, array_index = struct.unpack_from("<II", uexp, pos)
            pos += 8
            if kind == "StructProperty":
                pos += 24
            elif kind in ("ArrayProperty", "SetProperty", "ByteProperty", "EnumProperty"):
                pos += 8
            elif kind == "MapProperty":
                pos += 16
            elif kind == "BoolProperty":
                values[key] = bool(uexp[pos])
                pos += 1
            if uexp[pos]:
                pos += 16
            pos += 1 + size
            if pos > limit:
                raise ValueError("Cosmetic property exceeds export bounds")
        raise ValueError("Missing cosmetic property terminator")

    export_count, export_offset = struct.unpack_from("<II", uasset, 57)
    if export_count != 1:
        raise ValueError("Expected one cosmetic DataTable export")
    size, offset = struct.unpack_from("<qq", uasset, export_offset + 28)
    start = offset - len(uasset)
    limit = start + size
    if not 0 <= start <= limit <= len(uexp) - 4:
        raise ValueError("Invalid cosmetic export bounds")
    pos, _ = properties(start, limit)
    marker, count = struct.unpack_from("<II", uexp, pos)
    if marker != 0:
        raise ValueError("Unsupported cosmetic DataTable layout")
    pos += 8
    ids = set()
    for _ in range(count):
        catalog_id, pos = name_at(pos)
        pos, flags = properties(pos, limit)
        if flags.get("bCosmeticOnly") is not True or flags.get("IsStackable") is not True:
            raise ValueError("Unexpected cosmetic classification: " + catalog_id)
        # Preserve the existing grant policy; omit prototype/internal name scraps.
        if wanted(catalog_id) and ID_RE.fullmatch(catalog_id.encode("ascii")):
            ids.add(catalog_id)
    if pos != limit:
        raise ValueError("Cosmetic DataTable was not fully consumed")
    return ids


def collect_ids(blob, encoded, methods, files):
    instanced = set()
    stacked = {}
    potions = set()
    cosmetic = set()
    for path in CATALOG_FILES:
        if path not in files:
            if "cosmetic" in path:
                raise RuntimeError("Missing required cosmetic catalog: " + path)
            print("Missing catalog:", path)
            continue
        raw = extract_file(blob, encoded, methods, files[path])
        if "cosmetic" in path:
            export_path = path.removesuffix(".uasset") + ".uexp"
            if export_path not in files:
                raise RuntimeError("Missing cosmetic export: " + export_path)
            export = extract_file(blob, encoded, methods, files[export_path])
            ids = cosmetic_catalog_ids(raw, export)
            cosmetic.update(ids)
        else:
            ids = {match.decode() for match in ID_RE.findall(raw)}
        for catalog_id in ids:
            if not wanted(catalog_id):
                continue
            if path in POTION_FILES and (catalog_id.startswith("QI_") or catalog_id.startswith("FL_")):
                potions.add(catalog_id)
            if is_instanced(catalog_id):
                instanced.add(catalog_id)
            else:
                stacked[catalog_id] = max(stacked.get(catalog_id, 0), stack_qty(catalog_id, potions))
    talents = []
    for path in TALENT_FILES:
        if path not in files:
            continue
        raw = extract_file(blob, encoded, methods, files[path])
        talents.extend(match.decode() for match in re.findall(rb"ESC_TALENT_[A-Z0-9_]+", raw))
    # Finalize after all catalogs: gameplay name maps can also mention skins.
    instanced.difference_update(cosmetic)
    for catalog_id in cosmetic:
        stacked[catalog_id] = max(stacked.get(catalog_id, 0), 1)
    return instanced, stacked, potions, sorted(set(talents)), cosmetic

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export the Dauntless 1.14.7 unlock catalog")
    parser.add_argument("--pak", type=Path, required=True)
    parser.add_argument("--oodle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    OODLE = args.oodle.resolve()
    blob = args.pak.read_bytes()
    _, methods, encoded, files, _ = load_pak(blob)
    gear, stacks, potions, talents, skins = collect_ids(blob, encoded, methods, files)
    catalog = {
        "version": "1.14.7", "build": "647472",
        "sourcePak": args.pak.name, "sourceSha256": hashlib.sha256(blob).hexdigest(),
        "instanced": sorted(gear), "stacked": dict(sorted(stacks.items())),
        "cosmetics": sorted(skins), "potions": sorted(potions), "talents": talents,
    }
    args.output.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(gear)} gear, {len(stacks)} stacks, {len(skins)} cosmetics")
