//! Song waveforms for the SoundCloud-style seek bar.
//!
//! The whole file is decoded once and boiled down to `bins` loudness values (0..1), which are
//! cached on disk per song and bar count.

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

pub fn load_or_compute(path: &Path, bins: usize, cache_dir: &Path) -> Result<Vec<f32>, String> {
    let bins = bins.clamp(MIN_BINS, MAX_BINS);
    let mtime = fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
        .map_err(|e| e.to_string())?;
    let cache = cache_dir.join(format!("{}.json", crate::library::hash_hex(&format!("{}|{mtime}|{bins}", path.display()))));
    if let Some(peaks) = crate::library::load_json::<Vec<f32>>(&cache) {
        return Ok(peaks);
    }
    let peaks = compute(path, bins)?;
    crate::library::save_json(&cache, &peaks);
    Ok(peaks)
}

fn compute(path: &Path, bins: usize) -> Result<Vec<f32>, String> {
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
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {e}"))?;

    let mut chunk_peaks: Vec<f32> = Vec::new();
    let (mut peak, mut frames) = (0f32, 0usize);
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
        for frame in buf.samples().chunks(channels) {
            peak = frame.iter().fold(peak, |p, s| p.max(s.abs()));
            frames += 1;
            if frames == CHUNK {
                chunk_peaks.push(peak);
                (peak, frames) = (0.0, 0);
            }
        }
    }
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
