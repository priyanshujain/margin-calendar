# The Linux package: the deb the release workflow published, relinked against nixpkgs' own GTK and
# WebKit so it runs as a native Wayland client. It is a binary package by necessity: the Google
# OAuth client is embedded at compile time from a file that is deliberately not in the repo, so
# anything built from source here would run and then say Google Calendar is not set up.
{
  lib,
  stdenv,
  fetchurl,
  dpkg,
  autoPatchelfHook,
  wrapGAppsHook3,
  cairo,
  dbus,
  gdk-pixbuf,
  glib,
  glib-networking,
  gsettings-desktop-schemas,
  gtk3,
  libsoup_3,
  webkitgtk_4_1,
  xdg-utils,
}:

let
  release = lib.importJSON ./release.json;
in
stdenv.mkDerivation {
  pname = "margin-calendar";
  inherit (release) version;

  src = fetchurl {
    url = "https://github.com/priyanshujain/margin-calendar/releases/download/v${release.version}/Margin.Calendar_${release.version}_amd64.deb";
    inherit (release) hash;
  };

  unpackPhase = ''
    runHook preUnpack
    dpkg-deb -x $src .
    runHook postUnpack
  '';

  nativeBuildInputs = [
    dpkg
    autoPatchelfHook
    wrapGAppsHook3
  ];

  buildInputs = [
    cairo
    dbus
    gdk-pixbuf
    glib
    glib-networking
    gsettings-desktop-schemas
    gtk3
    libsoup_3
    webkitgtk_4_1
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r usr/bin usr/share $out/
    mv "$out/share/applications/Margin Calendar.desktop" $out/share/applications/margin-calendar.desktop
    runHook postInstall
  '';

  # The app opens the Google consent page and "Report an issue" through xdg-open. The variable is
  # how it knows the store owns the binary, so "Check for updates" points at Nix instead of trying
  # to replace itself.
  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : ${lib.makeBinPath [ xdg-utils ]}
      --set MARGIN_CALENDAR_PACKAGED_BY nix
    )
  '';

  meta = {
    description = "A calendar for Google Calendar";
    longDescription = "A calendar where the grid owns the window and the day always fits without scrolling.";
    homepage = "https://github.com/priyanshujain/margin-calendar";
    license = lib.licenses.mit;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = "margin-calendar";
  };
}
