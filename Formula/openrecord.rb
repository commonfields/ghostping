class Openrecord < Formula
  desc "Legacy local-first GEO CLI: track, generate, and optimize your brand's visibility in LLMs"
  homepage "https://github.com/commonfields/openrecord"
  version "0.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/commonfields/openrecord/releases/download/v#{version}/openrecord-macos-aarch64.tar.gz"
      sha256 "PLACEHOLDER_AARCH64_SHA256"
    end
    on_intel do
      url "https://github.com/commonfields/openrecord/releases/download/v#{version}/openrecord-macos-x86_64.tar.gz"
      sha256 "PLACEHOLDER_X86_64_SHA256"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/commonfields/openrecord/releases/download/v#{version}/openrecord-linux-x86_64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_SHA256"
    end
  end

  def install
    bin.install "openrecord"
  end

  def caveats
    <<~EOS
      To get started, run:
        openrecord init

      This will walk you through setting up your first LLM provider and domain to track.

      Documentation:
        openrecord docs
        openrecord quickstart
    EOS
  end

  test do
    assert_match "openrecord", shell_output("#{bin}/openrecord --version")
  end
end
