# Makefile for sscma-qrcode-reader

# Build variables
VERSION ?= 1.0.0

# Output directory
BUILD_DIR := build
BIN_NAME := sscma-qrcode-reader

# SDK paths
SDK_ROOT := ../../../reCamera-OS/output/sg2002_recamera_emmc/install/soc_sg2002_recamera_emmc
TPU_SDK := $(SDK_ROOT)/tpu_musl_riscv64/cvitek_tpu_sdk

# Cross-compilation for RISC-V
CXX := riscv64-unknown-linux-musl-g++
CC := riscv64-unknown-linux-musl-gcc
VIDEO_DIR := ../../components/sophgo/video
QUIRC_DIR := ../../components/quirc
CXXFLAGS := -std=c++17 -O2 -Wall -I$(VIDEO_DIR)/include -I$(QUIRC_DIR) -I$(TPU_SDK)/include
CFLAGS := -O2 -Wall -I$(VIDEO_DIR)/include -I$(QUIRC_DIR) -I$(TPU_SDK)/include
LDFLAGS := -lrt -lpthread -lstdc++ -L$(TPU_SDK)/lib -lavcodec -lavutil

# Quirc source files
QUIRC_SOURCES := $(QUIRC_DIR)/quirc.c \
                 $(QUIRC_DIR)/decode.c \
                 $(QUIRC_DIR)/identify.c \
                 $(QUIRC_DIR)/version_db.c

# Default target
.PHONY: all
all: build-riscv

# Build for RISC-V (target device)
.PHONY: build-riscv
build-riscv:
	@echo "Cross-compiling $(BIN_NAME) for RISC-V..."
	@mkdir -p $(BUILD_DIR)
	@# Build video_shm
	$(CC) $(CFLAGS) -c $(VIDEO_DIR)/src/video_shm.c -o $(BUILD_DIR)/video_shm.o
	@# Build quirc library
	$(CC) $(CFLAGS) -c $(QUIRC_DIR)/quirc.c -o $(BUILD_DIR)/quirc.o
	$(CC) $(CFLAGS) -c $(QUIRC_DIR)/decode.c -o $(BUILD_DIR)/decode.o
	$(CC) $(CFLAGS) -c $(QUIRC_DIR)/identify.c -o $(BUILD_DIR)/identify.o
	$(CC) $(CFLAGS) -c $(QUIRC_DIR)/version_db.c -o $(BUILD_DIR)/version_db.o
	@# Build main program
	$(CXX) $(CXXFLAGS) main/main.cpp \
		$(BUILD_DIR)/video_shm.o \
		$(BUILD_DIR)/quirc.o \
		$(BUILD_DIR)/decode.o \
		$(BUILD_DIR)/identify.o \
		$(BUILD_DIR)/version_db.o \
		$(LDFLAGS) -o $(BUILD_DIR)/$(BIN_NAME)
	@echo "Build complete: $(BUILD_DIR)/$(BIN_NAME)"

# Install to rootfs overlay (for packaging)
ROOTFS_DIR := rootfs
INSTALL_PATH := $(ROOTFS_DIR)/usr/bin/qr-reader

.PHONY: install
install: build-riscv
	@echo "Installing $(BIN_NAME) to $(INSTALL_PATH)..."
	@mkdir -p $(ROOTFS_DIR)/usr/bin
	@cp $(BUILD_DIR)/$(BIN_NAME) $(INSTALL_PATH)
	@chmod 755 $(INSTALL_PATH)
	@echo "Installed: $(INSTALL_PATH)"

# Create opkg package
.PHONY: opkg
opkg: build-riscv
	@echo "Creating opkg package..."
	@rm -rf $(BUILD_DIR)/opkg-stage
	@mkdir -p $(BUILD_DIR)/opkg-stage/CONTROL
	@mkdir -p $(BUILD_DIR)/opkg-stage/usr/bin
	@# Copy CONTROL files
	@cp opkg/CONTROL/control $(BUILD_DIR)/opkg-stage/CONTROL/
	@if [ -f opkg/CONTROL/postinst ]; then \
		cp opkg/CONTROL/postinst $(BUILD_DIR)/opkg-stage/CONTROL/; \
		chmod 755 $(BUILD_DIR)/opkg-stage/CONTROL/postinst; \
	fi
	@# Install the binary
	@cp $(BUILD_DIR)/$(BIN_NAME) $(BUILD_DIR)/opkg-stage/usr/bin/qr-reader
	@chmod 755 $(BUILD_DIR)/opkg-stage/usr/bin/qr-reader
	@# Create the opkg package
	@cd $(BUILD_DIR)/opkg-stage && \
		tar -czf ../data.tar.gz --owner=0 --group=0 ./usr && \
		tar -czf ../control.tar.gz --owner=0 --group=0 -C CONTROL . && \
		echo "2.0" > ../debian-binary && \
		cd .. && ar r qr-reader_$(VERSION)_riscv64.ipk debian-binary control.tar.gz data.tar.gz
	@rm -f $(BUILD_DIR)/debian-binary $(BUILD_DIR)/control.tar.gz $(BUILD_DIR)/data.tar.gz
	@echo "opkg package created: $(BUILD_DIR)/qr-reader_$(VERSION)_riscv64.ipk"

# Clean build artifacts
.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)

# Format code
.PHONY: fmt
fmt:
	clang-format -i main/main.cpp

# Help
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  all         - Build the project (default)"
	@echo "  build-riscv - Cross-compile for RISC-V"
	@echo "  install     - Build and install to rootfs/usr/bin/qr-reader"
	@echo "  opkg        - Build and create opkg package (.ipk)"
	@echo "  clean       - Remove build directory"
	@echo "  fmt         - Format code with clang-format"
	@echo "  help        - Show this help message"
