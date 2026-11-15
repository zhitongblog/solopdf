cask "solopdf" do
  version "1.1.0"
  sha256 "8286302db16cdbccd6402ffa47b1476fdd59a77a8c6cca8a0f2c2e6d46f153ea"

  url "https://github.com/zhitongblog/solopdf/releases/download/v#{version}/SoloPDF_#{version}_universal.dmg"
  name "SoloPDF"
  desc "Local-first PDF reader & offline toolkit where highlights become Markdown notes"
  homepage "https://solopdf.doaipm.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "SoloPDF.app"

  zap trash: [
    "~/Library/Application Support/app.solopdf",
    "~/Library/Caches/app.solopdf",
    "~/Library/Preferences/app.solopdf.plist",
    "~/Library/Saved Application State/app.solopdf.savedState",
    "~/Library/WebKit/app.solopdf",
  ]
end
