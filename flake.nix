{
  description = "SSCMA Example for SG200X - Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Sophgo host-tools containing the RISC-V toolchain
    host-tools = {
      url = "github:sophgo/host-tools";
      flake = false;
    };

    # reCamera-OS SDK - Use local flake if available, otherwise from GitHub
    # To use local: ensure ../reCamera-OS exists with flake.nix
    recamera-os = {
      url = "path:../reCamera-OS";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, host-tools, recamera-os }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Toolchain path inside host-tools repo
        toolchainSubdir = "gcc/riscv64-linux-musl-x86_64";

        # Build target for reCamera-OS
        buildTarget = "sg2002_recamera_emmc";

        # Get SDK from reCamera-OS flake
        # This will use the local flake or build from source
        recamera-sdk = recamera-os.packages.${system}."sdk-${buildTarget}";

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
            
            # SDK from reCamera-OS flake
            export SG200X_SDK_PATH="${recamera-sdk}/${buildTarget}"
            export TPU_SDK_PATH="${recamera-sdk}/${buildTarget}/tpu_musl_riscv64/cvitek_tpu_sdk"

            echo ""
            echo "════════════════════════════════════════════════════════════"
            echo "  SSCMA SG200X Development Environment"
            echo "════════════════════════════════════════════════════════════"
            echo ""
            echo "✓ Toolchain: ${host-tools}/${toolchainSubdir}"
            
            if [ -d "$SG200X_SDK_PATH" ]; then
              echo "✓ SDK: $SG200X_SDK_PATH"
              
              if [ -f "$SG200X_SDK_PATH/.nix-build-info" ]; then
                echo ""
                echo "SDK Build Info:"
                cat "$SG200X_SDK_PATH/.nix-build-info" | sed 's/^/  /'
              fi
              
              if [ -d "$TPU_SDK_PATH" ]; then
                echo ""
                echo "✓ TPU SDK: $TPU_SDK_PATH"
                
                # Add SDK libraries to path
                export PKG_CONFIG_PATH="$TPU_SDK_PATH/lib/pkgconfig:$PKG_CONFIG_PATH"
                export LD_LIBRARY_PATH="$TPU_SDK_PATH/lib:$LD_LIBRARY_PATH"
              else
                echo "⚠ TPU SDK not found at $TPU_SDK_PATH"
              fi
            else
              echo "✗ SDK not found at $SG200X_SDK_PATH"
              echo ""
              echo "The SDK should be built automatically by the reCamera-OS flake."
              echo "If you see this message, the build may have failed."
              echo ""
              echo "To rebuild:"
              echo "  cd ../reCamera-OS"
              echo "  nix build .#sdk-${buildTarget}"
            fi

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
            echo "SDK Sources:"
            if [ -f "${recamera-sdk}/${buildTarget}/.nix-build-info" ]; then
              grep "Source:" "${recamera-sdk}/${buildTarget}/.nix-build-info" | sed 's/^/  /'
            fi
            echo "════════════════════════════════════════════════════════════"
            echo ""
          '';

          runScript = "bash";
        };

      in
      {
        # Expose the SDK package from reCamera-OS
        packages = {
          inherit recamera-sdk;
          default = recamera-sdk;
        };

        devShells.default = pkgs.mkShell {
          name = "sscma-sg200x";

          buildInputs = [ fhsEnv ];

          shellHook = ''
            echo "════════════════════════════════════════════════════════════"
            echo " Starting SSCMA SG200X Development Environment"
            echo "════════════════════════════════════════════════════════════"
            echo ""
            echo "SDK: reCamera-OS (${buildTarget})"
            echo "  - Using flake from: ${recamera-os}"
            echo "  - Build managed by Nix"
            echo ""
            echo "First run will build SDK (1-2 hours)"
            echo "Subsequent runs use cached SDK (<1 minute)"
            echo ""
            echo "════════════════════════════════════════════════════════════"
            exec ${fhsEnv}/bin/sscma-sg200x-fhs
          '';
        };
      });
}
