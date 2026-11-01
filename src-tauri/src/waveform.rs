//! Song waveforms for the SoundCloud-style seek bar, and song loudness for "Normalize volume".
//!
//! The whole file is decoded once and boiled down to `bins` loudness values (0..1), or to one
//! volume adjustment, which are cached on disk per song.

use std::fs;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const MIN_BINS: usize = 16;
pub const MAX_BINS: usize = 2000;
/// Frames folded into one peak before binning; keeps memory flat for long songs while still
/// leaving enough chunks for MAX_BINS on short ones (256 frames ≈ 6 ms at 44.1 kHz).
const CHUNK: usize = 256;

fn mtime(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
        .map_err(|e| e.to_string())
}

pub fn load_or_compute(path: &Path, bins: usize, cache_dir: &Path) -> Result<Vec<f32>, String> {
    let bins = bins.clamp(MIN_BINS, MAX_BINS);
    let mtime = mtime(path)?;
    let cache = cache_dir.join(format!("{}.json", crate::library::hash_hex(&format!("{}|{mtime}|{bins}", path.display()))));
    if let Some(peaks) = crate::library::load_json::<Vec<f32>>(&cache) {
        return Ok(peaks);
    }
    let peaks = compute(path, bins)?;
    crate::library::save_json(&cache, &peaks);
    Ok(peaks)
}

/// Decode the whole song, handing each frame (one sample per channel) to `frame` along with the
/// sample rate.
fn decode(path: &Path, mut frame: impl FnMut(u32, &[f32])) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Unsupported audio: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track")?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {e}"))?;

    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // end of stream (or a broken tail we can ignore)
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        if buf.as_ref().map_or(true, |b| b.capacity() < decoded.capacity()) {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let buf = buf.as_mut().unwrap();
        buf.copy_interleaved_ref(decoded);
        for f in buf.samples().chunks(channels) {
            frame(rate, f);
        }
    }
    Ok(())
}

fn compute(path: &Path, bins: usize) -> Result<Vec<f32>, String> {
    let mut chunk_peaks: Vec<f32> = Vec::new();
    let (mut peak, mut frames) = (0f32, 0usize);
    decode(path, |_, frame| {
        peak = frame.iter().fold(peak, |p, s| p.max(s.abs()));
        frames += 1;
        if frames == CHUNK {
            chunk_peaks.push(peak);
            (peak, frames) = (0.0, 0);
        }
    })?;
    if frames > 0 {
        chunk_peaks.push(peak);
    }
    if chunk_peaks.is_empty() {
        return Err("No audio decoded".into());
    }

    // Average the chunk peaks into `bins` buckets, then scale so the loudest bucket is 1.
    // A very short song can have fewer chunks than buckets; neighbouring buckets then share one.
    let n = chunk_peaks.len();
    let mut out: Vec<f32> = (0..bins)
        .map(|b| {
            let start = (b * n / bins).min(n - 1);
            let end = ((b + 1) * n / bins).clamp(start + 1, n);
            chunk_peaks[start..end].iter().sum::<f32>() / (end - start) as f32
        })
        .collect();
    let max = out.iter().cloned().fold(0f32, f32::max);
    if max > 0.0 {
        for v in &mut out {
            *v = (*v / max * 1000.0).round() / 1000.0; // 3 decimals keeps the cache small
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ loudness

/// How loud songs are made to sound, in dB of the gated RMS below (about -14 LUFS for typical music).
const TARGET_DB: f32 = -16.0;
/// Songs are only ever turned down (the volume can't go above full), by at most this much.
const MAX_CUT_DB: f32 = -15.0;

/// The volume change, in dB (0 or less), that brings the song to the common loudness.
pub fn loudness_gain(path: &Path, cache_dir: &Path) -> Result<f32, String> {
    let cache = cache_dir.join(format!("{}.json", crate::library::hash_hex(&format!("{}|{}|loudness", path.display(), mtime(path)?))));
    if let Some(gain) = crate::library::load_json::<f32>(&cache) {
        return Ok(gain);
    }
    let gain = gain_for(measure(path)?);
    crate::library::save_json(&cache, &gain);
    Ok(gain)
}

fn gain_for(loudness_db: f32) -> f32 {
    (TARGET_DB - loudness_db).clamp(MAX_CUT_DB, 0.0)
}

/// Loudness in dB: the mean power of the song's 400 ms blocks, leaving out near-silent ones
/// (intros, gaps, fade-outs) the way loudness standards gate them.
fn measure(path: &Path) -> Result<f32, String> {
    let mut blocks: Vec<f64> = Vec::new();
    let (mut sum, mut frames) = (0f64, 0usize);
    decode(path, |rate, frame| {
        let mono = frame.iter().sum::<f32>() / frame.len() as f32;
        sum += f64::from(mono * mono);
        frames += 1;
        if frames >= (rate as usize * 2 / 5).max(1) {
            blocks.push(sum / frames as f64);
            (sum, frames) = (0.0, 0);
        }
    })?;
    if frames > 0 {
        blocks.push(sum / frames as f64);
    }
    gated_db(&blocks).ok_or_else(|| "The song is silent".to_string())
}

/// dB of the mean power of the blocks louder than -60 dB.
fn gated_db(blocks: &[f64]) -> Option<f32> {
    let gate = 10f64.powf(-6.0); // -60 dB
    let loud: Vec<f64> = blocks.iter().copied().filter(|p| *p > gate).collect();
    if loud.is_empty() {
        return None;
    }
    let mean = loud.iter().sum::<f64>() / loud.len() as f64;
    Some((10.0 * mean.log10()) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loud_songs_are_turned_down_and_quiet_ones_left() {
        assert_eq!(gain_for(-8.0), -8.0);
        assert_eq!(gain_for(-20.0), 0.0);
        assert_eq!(gain_for(0.0), MAX_CUT_DB);
    }

    /// A 16-bit mono WAV of `secs` of a 440 Hz sine at `amplitude` (0..1), then a second of silence.
    fn sine_wav(amplitude: f32, secs: u32) -> Vec<u8> {
        let rate = 44_100u32;
        let samples: Vec<i16> = (0..rate * (secs + 1))
            .map(|i| if i < rate * secs { (amplitude * (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 32767.0) as i16 } else { 0 })
            .collect();
        let data = samples.len() as u32 * 2;
        let mut out = Vec::new();
        for (tag, value) in [(b"RIFF", 36 + data)] {
            out.extend_from_slice(tag);
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&1u16.to_le_bytes()); // mono
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data.to_le_bytes());
        samples.iter().for_each(|s| out.extend_from_slice(&s.to_le_bytes()));
        out
    }

    #[test]
    fn measures_real_audio() {
        let dir = std::env::temp_dir().join(format!("yuuricloud-loudness-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let (loud, quiet) = (dir.join("loud.wav"), dir.join("quiet.wav"));
        fs::write(&loud, sine_wav(0.9, 3)).unwrap();
        fs::write(&quiet, sine_wav(0.05, 3)).unwrap();
        // a sine's power is amplitude² / 2: 0.9 -> -3.9 dB, 0.05 -> -29 dB. The silent second is gated
        // out; the block that's half song, half silence pulls each down a little.
        let (l, q) = (measure(&loud).unwrap(), measure(&quiet).unwrap());
        assert!((l - -3.9).abs() < 0.5, "{l}");
        assert!((q - -29.0).abs() < 0.5, "{q}");
        let cache = dir.join("cache");
        assert!((loudness_gain(&loud, &cache).unwrap() - -12.1).abs() < 0.5);
        assert_eq!(loudness_gain(&quiet, &cache).unwrap(), 0.0);
        assert_eq!(loudness_gain(&quiet, &cache).unwrap(), 0.0, "and again from the cache");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn silence_is_left_out() {
        // a full-scale sine has power 0.5 (-3 dB); the silent blocks don't pull it down
        let blocks = [0.5, 0.5, 0.0, 1e-9];
        let db = gated_db(&blocks).unwrap();
        assert!((db - -3.01).abs() < 0.05, "{db}");
        assert_eq!(gated_db(&[0.0, 1e-8]), None);
    }
}
