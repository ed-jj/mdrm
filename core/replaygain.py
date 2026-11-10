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
ReplayGain 2.0 calculation (EBU R128 / ITU-R BS.1770 loudness).

Loudness is measured with ffmpeg's ebur128 filter. Rather than using ffmpeg's
per-file summary, we collect the momentary loudness of every 400 ms gating
block (ffmpeg reports one every 100 ms, i.e. 75% overlap as per BS.1770) and
apply the BS.1770 gating ourselves. This gives the track loudness, and - by
gating the blocks of all tracks together - the true album loudness, the same
way foobar2000 / libebur128 compute album gain (not an average of tracks).

Gain is relative to the ReplayGain 2.0 reference level of -18 LUFS.
Peak is the sample peak (linear, 1.0 = full scale), as foobar2000 writes by default.
"""

import math
import os
import re
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from config import logger

REFERENCE_LOUDNESS = -18.0   # LUFS, ReplayGain 2.0 reference
ABSOLUTE_GATE = -70.0        # LUFS
RELATIVE_GATE = -10.0        # LU below ungated loudness

RG_FIELDS = (
    'REPLAYGAIN_TRACK_GAIN',
    'REPLAYGAIN_TRACK_PEAK',
    'REPLAYGAIN_ALBUM_GAIN',
    'REPLAYGAIN_ALBUM_PEAK',
)

_PEAK_RE = re.compile(r'Peak level dB:\s*(-?inf|-?[\d.]+)')


def _block_energy(loudness):
    return 10 ** ((loudness + 0.691) / 10)


def _energy_loudness(energy):
    return -0.691 + 10 * math.log10(energy)


def gated_loudness(block_loudness):
    """
    Integrated loudness (LUFS) from a list of 400 ms block loudness values,
    using BS.1770-4 absolute and relative gating. Returns None if every block
    is below the absolute gate (silence).
    """
    energies = [_block_energy(l) for l in block_loudness if l > ABSOLUTE_GATE]
    if not energies:
        return None
    relative_threshold = _energy_loudness(sum(energies) / len(energies)) + RELATIVE_GATE
    gated = [e for e in energies if _energy_loudness(e) > relative_threshold]
    if not gated:
        return None
    return _energy_loudness(sum(gated) / len(gated))


def analyze_file(filepath):
    """
    Decode a file with ffmpeg and measure it.

    Returns:
        dict with 'blocks' (list of block loudness values in LUFS),
        'peak' (linear sample peak) and 'loudness' (integrated LUFS or None)
    """
    cmd = [
        'ffmpeg', '-nostdin', '-hide_banner', '-nostats',
        '-i', filepath,
        '-map', '0:a:0', '-vn', '-sn', '-dn',
        '-af', 'astats=measure_perchannel=none,'
               'ebur128=metadata=1,'
               'ametadata=mode=print:key=lavfi.r128.M:file=-',
        '-f', 'null', '-'
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
    if proc.returncode != 0:
        last_line = (proc.stderr.strip().splitlines() or ['unknown error'])[-1]
        raise RuntimeError(f"ffmpeg failed: {last_line}")

    blocks = []
    for line in proc.stdout.splitlines():
        if line.startswith('lavfi.r128.M='):
            try:
                blocks.append(float(line.split('=', 1)[1]))
            except ValueError:
                pass

    peak_matches = _PEAK_RE.findall(proc.stderr)
    if not peak_matches:
        raise RuntimeError("Could not read peak level from ffmpeg output")
    peak_db = peak_matches[-1]
    peak = 0.0 if 'inf' in peak_db else 10 ** (float(peak_db) / 20)

    return {'blocks': blocks, 'peak': peak, 'loudness': gated_loudness(blocks)}


def format_gain(loudness):
    return f"{REFERENCE_LOUDNESS - loudness:.2f} dB"


def format_peak(peak):
    return f"{peak:.6f}"


def calculate_album(filepaths, progress_callback=None, max_workers=None):
    """
    Calculate track and album ReplayGain for a set of files (treated as one album).

    Returns:
        (results, errors) where results maps filepath -> {field: value} for the
        four REPLAYGAIN_* tags, and errors is a list of "filename: message".
    """
    if max_workers is None:
        max_workers = max(1, min(4, os.cpu_count() or 1))

    analyses = {}
    errors = []
    done = [0]
    lock = threading.Lock()

    def work(fp):
        try:
            result = analyze_file(fp)
            if result['loudness'] is None:
                raise RuntimeError("file is silent - cannot calculate gain")
            with lock:
                analyses[fp] = result
        except Exception as e:
            logger.error(f"ReplayGain analysis failed for {fp}: {e}")
            with lock:
                errors.append(f"{os.path.basename(fp)}: {e}")
        finally:
            with lock:
                done[0] += 1
                if progress_callback:
                    progress_callback(done[0], len(filepaths))

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        list(pool.map(work, filepaths))

    if not analyses:
        return {}, errors

    all_blocks = [b for a in analyses.values() for b in a['blocks']]
    album_loudness = gated_loudness(all_blocks)
    album_peak = max(a['peak'] for a in analyses.values())

    results = {}
    for fp, a in analyses.items():
        results[fp] = {
            'REPLAYGAIN_TRACK_GAIN': format_gain(a['loudness']),
            'REPLAYGAIN_TRACK_PEAK': format_peak(a['peak']),
            'REPLAYGAIN_ALBUM_GAIN': format_gain(album_loudness),
            'REPLAYGAIN_ALBUM_PEAK': format_peak(album_peak),
        }
    return results, errors


# ---------------------------------------------------------------------------
# Background jobs - a large album can take longer than the HTTP request timeout
# ---------------------------------------------------------------------------

_jobs = {}
_jobs_lock = threading.Lock()


def start_job(target, *args):
    """Run target(job, *args) in a background thread. Returns the job id."""
    job_id = str(uuid.uuid4())
    job = {
        'id': job_id,
        'status': 'running',      # running | done | error
        'stage': 'starting',
        'progress': 0,
        'total': 0,
        'message': '',
        'result': None,
        'created': time.time(),
    }
    with _jobs_lock:
        # Drop finished jobs older than an hour
        cutoff = time.time() - 3600
        for old_id in [k for k, v in _jobs.items() if v['status'] != 'running' and v['created'] < cutoff]:
            del _jobs[old_id]
        _jobs[job_id] = job

    def runner():
        try:
            target(job, *args)
            if job['status'] == 'running':
                job['status'] = 'done'
        except Exception as e:
            logger.error(f"ReplayGain job failed: {e}")
            job['status'] = 'error'
            job['message'] = str(e)

    threading.Thread(target=runner, daemon=True).start()
    return job_id


def get_job(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def is_running():
    with _jobs_lock:
        return any(j['status'] == 'running' for j in _jobs.values())
