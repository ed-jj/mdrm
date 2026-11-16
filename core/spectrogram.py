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
Spectrogram images for audio files, rendered by ffmpeg's showspectrumpic filter
(frequency axis in Hz, time axis, dBFS colour scale), with a small disk cache.
"""

import hashlib
import os
import subprocess
import tempfile
import threading

from config import logger

FREQUENCY_SCALES = ('lin', 'log')
CHANNEL_MODES = ('combined', 'separate')
MIN_WIDTH, MAX_WIDTH = 120, 3200
MIN_HEIGHT, MAX_HEIGHT = 120, 2400
CACHE_MAX_FILES = 40
FFMPEG_TIMEOUT = 110  # stay under gunicorn's 120 s worker timeout

_supported = None
_lock = threading.Lock()


def is_supported():
    """True if ffmpeg is installed with the showspectrumpic filter and a PNG encoder."""
    global _supported
    if _supported is None:
        try:
            filters = subprocess.run(['ffmpeg', '-hide_banner', '-filters'],
                                     capture_output=True, text=True, timeout=15).stdout
            encoders = subprocess.run(['ffmpeg', '-hide_banner', '-encoders'],
                                      capture_output=True, text=True, timeout=15).stdout
            _supported = 'showspectrumpic' in filters and ' png ' in encoders
        except Exception as e:
            logger.info(f"Spectrograms unavailable: {e}")
            _supported = False
    return _supported


def _clamp(value, low, high, default):
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


def normalise_options(width=None, height=None, fscale=None, mode=None, legend=None):
    """
    Validate request options, falling back to defaults.
    width/height are the size of the plot area; with legend=True ffmpeg adds
    its own axes and colour scale around it (about 280 x 130 px extra).
    """
    width = _clamp(width, MIN_WIDTH, MAX_WIDTH, 1600)
    height = _clamp(height, MIN_HEIGHT, MAX_HEIGHT, width // 2)
    fscale = fscale if fscale in FREQUENCY_SCALES else 'lin'
    mode = mode if mode in CHANNEL_MODES else 'combined'
    legend = str(legend).lower() not in ('0', 'false', 'no')
    return width, height, fscale, mode, legend


def _cache_dir():
    path = os.path.join(tempfile.gettempdir(), 'mdrm-spectrograms')
    os.makedirs(path, exist_ok=True)
    return path


def _cache_key(filepath, width, height, fscale, mode, legend):
    stat = os.stat(filepath)
    raw = f"{filepath}|{stat.st_mtime_ns}|{stat.st_size}|{width}x{height}|{fscale}|{mode}|{int(legend)}"
    return hashlib.sha1(raw.encode('utf-8', 'surrogateescape')).hexdigest()


def _prune_cache(directory):
    try:
        entries = [os.path.join(directory, f) for f in os.listdir(directory) if f.endswith('.png')]
        entries.sort(key=os.path.getmtime, reverse=True)
        for old in entries[CACHE_MAX_FILES:]:
            os.remove(old)
    except OSError:
        pass


def render(filepath, width, height, fscale, mode, legend=True):
    """
    Return the spectrogram PNG for a file (bytes), rendering it with ffmpeg if
    it isn't cached yet. Raises RuntimeError if ffmpeg fails.
    """
    directory = _cache_dir()
    cached = os.path.join(directory, _cache_key(filepath, width, height, fscale, mode, legend) + '.png')
    if os.path.exists(cached):
        os.utime(cached, None)  # keep recently used images in the cache
        with open(cached, 'rb') as f:
            return f.read()

    spectrum = (f"showspectrumpic=s={width}x{height}:legend={int(legend)}:mode={mode}"
                f":color=intensity:scale=log:fscale={fscale}:win_func=hann")
    cmd = [
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', filepath,
        '-filter_complex', f'[0:a:0]{spectrum}[v]',
        '-map', '[v]', '-frames:v', '1',
        '-f', 'image2pipe', '-c:v', 'png', '-'
    ]
    # One render at a time: decoding a long hi-res file is CPU heavy
    with _lock:
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise RuntimeError("Spectrogram took too long to render")
    if proc.returncode != 0 or not proc.stdout.startswith(b'\x89PNG'):
        message = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise RuntimeError(message[-1] if message else 'ffmpeg failed')

    try:
        tmp = cached + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(proc.stdout)
        os.replace(tmp, cached)
        _prune_cache(directory)
    except OSError as e:
        logger.warning(f"Could not cache spectrogram: {e}")
    return proc.stdout


def audio_info(filepath):
    """Basic stream details shown above the spectrogram."""
    info = {}
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(filepath)
        if audio is not None and getattr(audio, 'info', None) is not None:
            i = audio.info
            info['codec'] = type(audio).__name__.replace('Ogg', '').upper()
            if getattr(i, 'sample_rate', None):
                info['sample_rate'] = f"{i.sample_rate / 1000:g} kHz"
                info['sample_rate_hz'] = int(i.sample_rate)
            bits = getattr(i, 'bits_per_sample', None)
            if bits:
                info['bit_depth'] = f"{bits}-bit"
            if getattr(i, 'channels', None):
                info['channels'] = {1: 'mono', 2: 'stereo'}.get(i.channels, f"{i.channels} channels")
                info['channel_count'] = int(i.channels)
            if getattr(i, 'bitrate', None):
                info['bitrate'] = f"{round(i.bitrate / 1000)} kbps"
            if getattr(i, 'length', None):
                info['duration_seconds'] = float(i.length)
                total = int(round(i.length))
                info['duration'] = f"{total // 60}:{total % 60:02d}"
    except Exception as e:
        logger.warning(f"Could not read audio info for {filepath}: {e}")
    return info
