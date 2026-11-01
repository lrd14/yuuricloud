//! How good a song file sounds, from its format and stream: for keeping the best copy when the
//! same song is in the library more than once.

use std::path::Path;

use lofty::file::{AudioFile, FileType, TaggedFileExt};
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// "FLAC", "MP3", "AAC", "ALAC", "Opus", …
    pub format: String,
    pub lossless: bool,
    /// kbps
    pub bitrate: u32,
    /// Hz
    pub sample_rate: u32,
    pub bit_depth: u8,
    pub size: u64,
}

impl Quality {
    /// Bigger is better. Lossless always beats lossy; then more bits and a higher sample rate;
    /// then the bitrate, counting Opus and AAC as worth more than MP3 at the same rate.
    pub fn score(&self) -> f64 {
        if self.lossless {
            1e9 + self.bit_depth as f64 * 1e6 + self.sample_rate as f64 * 10.0 + self.bitrate as f64
        } else {
            let worth = match self.format.as_str() {
                "Opus" => 1.6,
                "AAC" => 1.3,
                "Vorbis" => 1.25,
                "MP3" => 1.0,
                _ => 0.9,
            };
            self.bitrate as f64 * worth * 1000.0 + self.sample_rate as f64 / 1000.0
        }
    }

    /// "FLAC 24-bit 96 kHz", "MP3 320 kbps"
    pub fn label(&self) -> String {
        if self.lossless {
            let depth = if self.bit_depth > 0 { format!(" {}-bit", self.bit_depth) } else { String::new() };
            let rate = if self.sample_rate > 0 { format!(" {} kHz", trim_khz(self.sample_rate)) } else { String::new() };
            format!("{}{depth}{rate}", self.format)
        } else if self.bitrate > 0 {
            format!("{} {} kbps", self.format, self.bitrate)
        } else {
            self.format.clone()
        }
    }
}

fn trim_khz(hz: u32) -> String {
    let k = hz as f64 / 1000.0;
    if k.fract() == 0.0 { format!("{k:.0}") } else { format!("{k:.1}") }
}

pub fn read(path: &Path) -> Quality {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let Ok(file) = lofty::read_from_path(path) else {
        return Quality { format: ext.to_uppercase(), size, ..Default::default() };
    };
    let p = file.properties();
    let bit_depth = p.bit_depth().unwrap_or(0);
    let (format, lossless) = match file.file_type() {
        FileType::Flac => ("FLAC", true),
        FileType::Wav => ("WAV", true),
        FileType::Aiff => ("AIFF", true),
        FileType::Ape => ("APE", true),
        FileType::WavPack => ("WavPack", true),
        // an .m4a is ALAC (lossless, has a bit depth) or AAC
        FileType::Mp4 if bit_depth > 0 => ("ALAC", true),
        FileType::Mp4 => ("AAC", false),
        FileType::Mpeg => ("MP3", false),
        FileType::Opus => ("Opus", false),
        FileType::Vorbis => ("Vorbis", false),
        _ => ("", false),
    };
    let duration = p.duration().as_secs_f64();
    // the stream's bitrate, or else worked out from the size
    let bitrate = p.audio_bitrate().filter(|b| *b > 0).unwrap_or_else(|| if duration > 0.0 { (size as f64 * 8.0 / duration / 1000.0) as u32 } else { 0 });
    Quality {
        format: if format.is_empty() { ext.to_uppercase() } else { format.to_string() },
        lossless,
        bitrate,
        sample_rate: p.sample_rate().unwrap_or(0),
        bit_depth,
        size,
    }
}

/// The index of the best of several copies: the highest score, then the biggest file.
pub fn best(copies: &[Quality]) -> usize {
    (0..copies.len())
        .max_by(|&a, &b| copies[a].score().total_cmp(&copies[b].score()).then(copies[a].size.cmp(&copies[b].size)))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(format: &str, lossless: bool, bitrate: u32, sample_rate: u32, bit_depth: u8) -> Quality {
        Quality { format: format.into(), lossless, bitrate, sample_rate, bit_depth, size: 0 }
    }

    #[test]
    fn picks_the_best_copy() {
        let mp3 = q("MP3", false, 320, 44100, 0);
        let opus = q("Opus", false, 160, 48000, 0);
        let flac = q("FLAC", true, 900, 44100, 16);
        let hires = q("FLAC", true, 2900, 96000, 24);
        assert_eq!(best(&[mp3.clone(), flac.clone(), opus.clone()]), 1, "lossless beats any lossy");
        assert_eq!(best(&[flac.clone(), hires.clone()]), 1, "24-bit beats 16-bit");
        assert_eq!(best(&[q("MP3", false, 128, 44100, 0), mp3.clone()]), 1, "320 kbps beats 128");
        assert_eq!(best(&[q("MP3", false, 192, 44100, 0), opus.clone()]), 1, "Opus 160 sounds better than MP3 192");
        assert_eq!(hires.label(), "FLAC 24-bit 96 kHz");
        assert_eq!(mp3.label(), "MP3 320 kbps");
        assert_eq!(q("FLAC", true, 0, 44100, 16).label(), "FLAC 16-bit 44.1 kHz");
    }
}

