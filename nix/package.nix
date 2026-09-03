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
  mesa,
  runtimeShell,
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

  # The binary sits under lib/ so wrapGAppsHook wraps the launcher in bin/ and nothing else.
  #
  # Outside NixOS there is no /run/opengl-driver, so the libglvnd this build links finds no EGL
  # driver and WebKit aborts its web process on the spot. The launcher points it at nixpkgs' Mesa
  # instead, unless something like nixGL already did. The xdg-open shim strips that again for the
  # browser the app opens, which has a Mesa of its own.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/lib/margin-calendar/bin
    cp usr/bin/margin-calendar $out/lib/margin-calendar/
    cp -r usr/share $out/
    mv "$out/share/applications/Margin Calendar.desktop" $out/share/applications/margin-calendar.desktop

    cat > $out/bin/margin-calendar <<LAUNCHER
    #!${runtimeShell}
    if [ ! -d /run/opengl-driver ]; then
      : "\''${__EGL_VENDOR_LIBRARY_FILENAMES:=$(echo ${mesa}/share/glvnd/egl_vendor.d/*.json)}"
      : "\''${LIBGL_DRIVERS_PATH:=${mesa}/lib/dri}"
      : "\''${GBM_BACKENDS_PATH:=${mesa}/lib/gbm}"
      export __EGL_VENDOR_LIBRARY_FILENAMES LIBGL_DRIVERS_PATH GBM_BACKENDS_PATH
    fi
    exec $out/lib/margin-calendar/margin-calendar "\$@"
    LAUNCHER

    cat > $out/lib/margin-calendar/bin/xdg-open <<SHIM
    #!${runtimeShell}
    unset __EGL_VENDOR_LIBRARY_FILENAMES LIBGL_DRIVERS_PATH GBM_BACKENDS_PATH
    exec ${xdg-utils}/bin/xdg-open "\$@"
    SHIM

    chmod +x $out/bin/margin-calendar $out/lib/margin-calendar/bin/xdg-open
    runHook postInstall
  '';

  # The variable is how the app knows the store owns the binary, so "Check for updates" points at
  # Nix instead of trying to replace itself.
  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : $out/lib/margin-calendar/bin
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
