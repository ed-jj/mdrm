# Metadata Remote - Intelligent audio metadata editor
# Copyright (C) 2025 Dr. William Nelson Leonard
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
Dynamic Range (DR) measurement, compatible with foobar2000's foo_dynamic_range
(the Pleasurize Music Foundation "TT DR" algorithm):

  * Each channel is split into 3-second blocks (the last, shorter block counts
    as a block too). Per block: RMS = sqrt(2 * mean(x^2)) and the sample peak.
  * Channel DR = 20*log10(second-highest block peak / RMS of the loudest 20%
    of blocks), where the RMS of those blocks is sqrt(mean(rms^2)).
  * Track DR = mean of the channel DRs, rounded to an integer.
  * Album ("Official") DR = mean of the rounded track DRs, rounded.
  * The log's Peak column is the track's highest sample peak and its RMS
    column the power average of all block RMS values (both in dBFS).

ffmpeg does the decoding and per-block statistics (astats); the arithmetic is
done here. Samples are converted to floating point first so levels are
measured against full scale = 1.0, as foobar2000 does.
"""

import math
import os
import re
import subprocess
from datetime import datetime

from config import logger

TAG_TRACK = 'DYNAMIC RANGE'
TAG_ALBUM = 'ALBUM DYNAMIC RANGE'
LOG_FILENAME = 'foo_dr.txt'
BLOCK_SECONDS = 3
TOP_FRACTION = 0.2

_LEVEL_RE = re.compile(r'^lavfi\.astats\.(\d+)\.(RMS_level|Peak_level)=(.*)$')


def _round_half_up(value):
    return int(math.floor(value + 0.5))


def _from_db(db):
    return 0.0 if db == float('-inf') else 10 ** (db / 20)


def _to_db(value):
    return 20 * math.log10(value) if value > 0 else float('-inf')


def _parse_db(text):
    text = text.strip().lower()
    if text in ('-inf', 'inf', 'nan', ''):
        return float('-inf')
    return float(text)


def block_levels(filepath, sample_rate):
    """
    Per-channel lists of (rms, peak) for each 3-second block, as linear values
    (rms already includes the DR meter's sqrt(2) factor).
    """
    block = max(1, int(sample_rate) * BLOCK_SECONDS)
    cmd = [
        'ffmpeg', '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error',
        '-i', filepath,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-af', (f'aformat=sample_fmts=dbl|dblp,'
                f'asetnsamples=n={block}:p=0,'
                f'astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=RMS_level+Peak_level,'
                f'ametadata=mode=print:file=-'),
        '-f', 'null', '-'
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
    if proc.returncode != 0:
        last = (proc.stderr.strip().splitlines() or ['unknown error'])[-1]
        raise RuntimeError(f"ffmpeg failed: {last}")

    channels = {}
    current = {}
    for line in proc.stdout.splitlines():
        if line.startswith('frame:'):
            current = {}
            continue
        m = _LEVEL_RE.match(line)
        if not m:
            continue
        ch, key, value = int(m.group(1)), m.group(2), _parse_db(m.group(3))
        entry = current.setdefault(ch, {})
        entry[key] = value
        if 'RMS_level' in entry and 'Peak_level' in entry:
            rms = _from_db(entry['RMS_level']) * math.sqrt(2)
            peak = _from_db(entry['Peak_level'])
            channels.setdefault(ch, []).append((rms, peak))
            current[ch] = {}
    if not channels:
        raise RuntimeError("no audio blocks measured")
    return [channels[ch] for ch in sorted(channels)]


def channel_dr(blocks):
    """DR (unrounded) of one channel from its (rms, peak) blocks, or None if silent."""
    rms_sorted = sorted((b[0] for b in blocks), reverse=True)
    peaks_sorted = sorted((b[1] for b in blocks), reverse=True)
    count = max(1, int(len(rms_sorted) * TOP_FRACTION))
    top_rms = math.sqrt(sum(r * r for r in rms_sorted[:count]) / count)
    peak = peaks_sorted[1] if len(peaks_sorted) > 1 else peaks_sorted[0]
    if top_rms <= 0 or peak <= 0:
        return None
    return _to_db(peak / top_rms)


def audio_details(filepath):
    """Sample rate, channels, bits, bitrate, codec, duration and tag info for the log."""
    from mutagen import File as MutagenFile
    details = {'sample_rate': 44100, 'channels': 2, 'bits': None, 'bitrate': None,
               'codec': os.path.splitext(filepath)[1].lstrip('.').upper(), 'duration': 0.0,
               'title': None, 'track': None, 'artist': None, 'album': None, 'albumartist': None}
    audio = MutagenFile(filepath, easy=True)
    if audio is not None:
        info = audio.info
        details['sample_rate'] = getattr(info, 'sample_rate', 44100) or 44100
        details['channels'] = getattr(info, 'channels', 2) or 2
        details['bits'] = getattr(info, 'bits_per_sample', None)
        details['bitrate'] = getattr(info, 'bitrate', None)
        details['duration'] = getattr(info, 'length', 0.0) or 0.0
        codec = type(audio).__name__.replace('Easy', '').replace('Ogg', '')
        details['codec'] = {'MP3': 'MP3', 'FLAC': 'FLAC', 'MP4': 'AAC', 'Vorbis': 'Vorbis',
                            'Opus': 'Opus', 'ASF': 'WMA', 'WavPack': 'WavPack',
                            'WAVE': 'PCM'}.get(codec, codec.upper())
        tags = audio.tags or {}

        def first(key):
            try:
                value = tags.get(key)
            except Exception:
                value = None
            if isinstance(value, list):
                value = value[0] if value else None
            return str(value).strip() if value else None

        details['title'] = first('title')
        details['track'] = first('tracknumber')
        details['artist'] = first('artist')
        details['album'] = first('album')
        details['albumartist'] = first('albumartist')
    return details


def analyze_file(filepath):
    """
    Measure one file. Returns dict with dr (unrounded), dr_rounded, peak_db,
    rms_db and the audio details.
    """
    details = audio_details(filepath)
    channels = block_levels(filepath, details['sample_rate'])

    drs = [d for d in (channel_dr(b) for b in channels) if d is not None]
    if not drs:
        raise RuntimeError("file is silent - cannot measure dynamic range")
    dr = sum(drs) / len(drs)

    peak = max(b[1] for blocks in channels for b in blocks)
    channel_rms = []
    for blocks in channels:
        channel_rms.append(math.sqrt(sum(b[0] * b[0] for b in blocks) / len(blocks)))
    rms = math.sqrt(sum(r * r for r in channel_rms) / len(channel_rms))

    result = dict(details)
    result.update(dr=dr, dr_rounded=_round_half_up(dr), peak_db=_to_db(peak), rms_db=_to_db(rms))
    return result


def album_dr(results):
    """Official album DR: mean of the rounded track values, rounded."""
    values = [r['dr_rounded'] for r in results]
    return _round_half_up(sum(values) / len(values)) if values else None


# ---------------------------------------------------------------------------
# foo_dr.txt
# ---------------------------------------------------------------------------

def _fmt_db(value):
    if value == float('-inf'):
        return '-inf'
    text = f"{value:.2f}"
    return '0.00' if text == '-0.00' else text


def _fmt_duration(seconds):
    total = _round_half_up(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _track_label(result, filepath):
    title = result.get('title') or os.path.splitext(os.path.basename(filepath))[0]
    track = (result.get('track') or '').split('/')[0].strip()
    if track.isdigit():
        return f"{int(track):02d}-{title}"
    return title


def _common(values, mixed='Mixed'):
    values = [v for v in values if v not in (None, '')]
    if not values:
        return None
    return values[0] if all(v == values[0] for v in values) else mixed


def build_log(results_by_path, version_label='mdrm'):
    """
    Text of foo_dr.txt in foo_dynamic_range's layout.
    results_by_path: list of (filepath, result) in track order.
    """
    results = [r for _, r in results_by_path]
    line = '-' * 80
    artist = _common([r.get('albumartist') or r.get('artist') for r in results], 'Various Artists') or 'Unknown Artist'
    album = _common([r.get('album') for r in results]) or 'Unknown Album'

    out = [
        f"{version_label} / Dynamic Range Meter (foo_dynamic_range compatible)",
        f"log date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        line,
        f"Analyzed: {artist} / {album}",
        line,
        "",
        f"{'DR':<5}{'Peak':>10}{'RMS':>12}{'Duration':>13} Track",
        line,
    ]
    for filepath, r in results_by_path:
        out.append(f"{'DR' + str(r['dr_rounded']):<5}{_fmt_db(r['peak_db']):>10} dB"
                   f"{_fmt_db(r['rms_db']):>9} dB{_fmt_duration(r['duration']):>10} "
                   f"{_track_label(r, filepath)}")
    out.append(line)

    total_seconds = sum(r['duration'] for r in results)
    bitrates = [(r['bitrate'] or 0) * r['duration'] for r in results]
    avg_kbps = _round_half_up(sum(bitrates) / total_seconds / 1000) if total_seconds and any(bitrates) else None
    rate = _common([r['sample_rate'] for r in results])
    channels = _common([r['channels'] for r in results])
    bits = _common([r['bits'] for r in results])
    codec = _common([r['codec'] for r in results])

    out += [
        "",
        f"Number of tracks:  {len(results)}",
        f"Official DR value: DR{album_dr(results)}",
        "",
        f"Samplerate:        {rate} Hz" if isinstance(rate, int) else f"Samplerate:        {rate or '-'}",
        f"Channels:          {channels or '-'}",
    ]
    if bits:
        out.append(f"Bits per sample:   {bits}")
    out += [
        f"Bitrate:           {avg_kbps} kbps" if avg_kbps else "Bitrate:           -",
        f"Codec:             {codec or '-'}",
        '=' * 80,
    ]
    return "\n".join(out) + "\n"


def sort_key(item):
    """Order files like the log: by track number, then file name."""
    filepath, result = item
    track = (result.get('track') or '').split('/')[0].strip()
    return (int(track) if track.isdigit() else 10 ** 6, os.path.basename(filepath).lower())
