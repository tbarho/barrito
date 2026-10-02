# rendered by .github/workflows/release.yml — __VERSION__/__URL__/__SHA256__ placeholders
class Barrito < Formula
  desc "One local router, every identity"
  homepage "https://github.com/tbarho/barrito"
  url "__URL__"
  sha256 "__SHA256__"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "__VERSION__", shell_output("#{bin}/barrito --version")
  end
end
