class Ghostping < Formula
  desc "Local-first GEO agent: track, generate, and optimize your brand's visibility in LLMs"
  homepage "https://github.com/commonfields/ghostping"
  version "0.3.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/commonfields/ghostping/releases/download/v#{version}/ghostping-macos-aarch64.tar.gz"
      sha256 "PLACEHOLDER_AARCH64_SHA256"
    end
    on_intel do
      url "https://github.com/commonfields/ghostping/releases/download/v#{version}/ghostping-macos-x86_64.tar.gz"
      sha256 "PLACEHOLDER_X86_64_SHA256"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/commonfields/ghostping/releases/download/v#{version}/ghostping-linux-x86_64.tar.gz"
      sha256 "PLACEHOLDER_LINUX_SHA256"
    end
  end

  def install
    bin.install "ghostping"
  end

  def caveats
    <<~EOS
      To get started, run:
        ghostping init

      This will walk you through setting up your first LLM provider and domain to track.

      Documentation:
        ghostping docs
        ghostping quickstart
    EOS
  end

  test do
    assert_match "ghostping", shell_output("#{bin}/ghostping --version")
  end
end
