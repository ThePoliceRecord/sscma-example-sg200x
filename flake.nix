{
  description = "SSCMA Example for SG200X - Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Fetch host-tools from GitHub archive zip
        # Note: If toolchains are in Git LFS, this won't include them!
        # We'll test and see...
        host-tools = pkgs.fetchzip {
          url = "https://github.com/sophgo/host-tools/archive/refs/heads/master.zip";
          sha256 = "sha256-OARUHjWRIcsKo0LVm1T4/CBaf2Lis3YKO9ZXfC5KD8E=";
          stripRoot = true;
        };

        # Toolchain path inside host-tools repo
        toolchainSubdir = "gcc/riscv64-linux-musl-x86_64";

        # Build target for reCamera-OS
        buildTarget = "sg2002_recamera_emmc";
        
        # Check if reCamera-OS exists at ../reCamera-OS
        recameraOsPath = ../reCamera-OS;
        hasRecameraOs = builtins.pathExists recameraOsPath;

        # SDK path - use manual build if exists
        sdkPath = if hasRecameraOs && builtins.pathExists (recameraOsPath + "/output/${buildTarget}")
          then "${recameraOsPath}/output/${buildTarget}"
          else null;

        # FHS environment for running the toolchain
        fhsEnv = pkgs.buildFHSEnv {
          name = "sscma-sg200x-fhs";

          targetPkgs = pkgs: with pkgs; [
            # Build tools
            cmake
            ninja
            gnumake
            pkg-config

            # Version control
            git

            # Deploy tools
            openssh
            rsync

            # Debugging/analysis
            file
            binutils

            # Required for toolchain
            stdenv.cc.cc.lib
            zlib
            ncurses5
            python3
            glibc
          ];

          profile = ''
            # Project root
            export PROJECT_ROOT="$(pwd)"

            # Toolchain from Nix store (fetched from sophgo/host-tools)
            export TOOLCHAIN_PATH="${host-tools}/${toolchainSubdir}"
            export PATH="$TOOLCHAIN_PATH/bin:$PATH"
            
            echo ""
            echo "════════════════════════════════════════════════════════════"
            echo "  SSCMA SG200X Development Environment"
            echo "════════════════════════════════════════════════════════════"
            echo ""
            echo "✓ Toolchain: ${host-tools}/${toolchainSubdir}"
            
            ${if sdkPath != null then ''
              # SDK from manual build
              export SG200X_SDK_PATH="${sdkPath}"
              export TPU_SDK_PATH="${sdkPath}/tpu_musl_riscv64/cvitek_tpu_sdk"
              
              if [ -d "$SG200X_SDK_PATH" ]; then
                echo "✓ SDK (manual build): $SG200X_SDK_PATH"
                
                if [ -d "$TPU_SDK_PATH" ]; then
                  echo "✓ TPU SDK: $TPU_SDK_PATH"
                  export PKG_CONFIG_PATH="$TPU_SDK_PATH/lib/pkgconfig:$PKG_CONFIG_PATH"
                  export LD_LIBRARY_PATH="$TPU_SDK_PATH/lib:$LD_LIBRARY_PATH"
                fi
              fi
            '' else ''
              echo "⚠ No SDK found"
              echo ""
              echo "Build SDK first from main project:"
              echo "  cd ../../  # Back to authority-alert root"
              echo "  nix run .#build"
              echo ""
              echo "Or build in reCamera-OS directly:"
              echo "  cd ../reCamera-OS"
              echo "  nix develop  # Then run docker_build.sh"
            ''}

            echo ""
            # Verify toolchain
            if command -v riscv64-unknown-linux-musl-gcc &> /dev/null; then
              echo "✓ Compiler: $(riscv64-unknown-linux-musl-gcc --version | head -1)"
            else
              echo "⚠ Toolchain compiler not found in PATH"
            fi

            echo ""
            echo "════════════════════════════════════════════════════════════"
            echo ""
            echo "Quick Start:"
            echo "  cd solutions/helloworld"
            echo "  cmake -B build -DCMAKE_BUILD_TYPE=Release ."
            echo "  cmake --build build"
            echo ""
            echo "════════════════════════════════════════════════════════════"
            echo ""
          '';

          runScript = "bash";
        };

      in
      {
        devShells.default = pkgs.mkShell {
          name = "sscma-sg200x";

          buildInputs = [ fhsEnv ];

          shellHook = ''
            echo "════════════════════════════════════════════════════════════"
            echo " Starting SSCMA SG200X Development Environment"
            echo "════════════════════════════════════════════════════════════"
            exec ${fhsEnv}/bin/sscma-sg200x-fhs
          '';
        };
      });
}
