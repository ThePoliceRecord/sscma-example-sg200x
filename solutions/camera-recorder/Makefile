# Makefile for camera-recorder

# Build variables
VERSION ?= 1.0.0
BUILD_TIME := $(shell date -u '+%Y-%m-%d %H:%M:%S')
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Output directory
BUILD_DIR := build
BIN_NAME := camera-recorder

# Cross-compilation for RISC-V
CXX := riscv64-unknown-linux-musl-g++
CC := riscv64-unknown-linux-musl-gcc
VIDEO_DIR := ../../components/sophgo/video
SDK_DIR := ../../../reCamera-OS/output/sg2002_recamera_emmc/install/soc_sg2002_recamera_emmc/tpu_musl_riscv64/cvitek_tpu_sdk
CXXFLAGS := -std=c++17 -O2 -Wall -I$(VIDEO_DIR)/include -I$(SDK_DIR)/include
CFLAGS := -O2 -Wall -I$(VIDEO_DIR)/include -I$(SDK_DIR)/include
LDFLAGS := -L$(SDK_DIR)/lib -lrt -lpthread -lstdc++ -lavformat -lavcodec -lavutil -lm -lz

# Default target
.PHONY: all
all: build-riscv

# Build for RISC-V (target device)
.PHONY: build-riscv
build-riscv:
	@echo "Cross-compiling $(BIN_NAME) for RISC-V..."
	@mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $(VIDEO_DIR)/src/video_shm.c -o $(BUILD_DIR)/video_shm.o
	$(CXX) $(CXXFLAGS) main.cpp $(BUILD_DIR)/video_shm.o $(LDFLAGS) -o $(BUILD_DIR)/$(BIN_NAME)
	@echo "Build complete: $(BUILD_DIR)/$(BIN_NAME)"

# Create release package (standalone)
.PHONY: package
package: build-riscv
	@echo "Creating release package..."
	@mkdir -p $(BUILD_DIR)/package/usr/local/bin
	@cp $(BUILD_DIR)/$(BIN_NAME) $(BUILD_DIR)/package/usr/local/bin/
	@tar -czf $(BUILD_DIR)/$(BIN_NAME)-$(VERSION)-riscv64.tar.gz -C $(BUILD_DIR)/package .
	@echo "Package created: $(BUILD_DIR)/$(BIN_NAME)-$(VERSION)-riscv64.tar.gz"

# Create opkg package
.PHONY: opkg
opkg: build-riscv
	@echo "Creating opkg package..."
	@rm -rf $(BUILD_DIR)/opkg-stage
	@mkdir -p $(BUILD_DIR)/opkg-stage/CONTROL
	@mkdir -p $(BUILD_DIR)/opkg-stage/usr/local/bin
	@# Copy CONTROL files
	@cp opkg/CONTROL/control $(BUILD_DIR)/opkg-stage/CONTROL/
	@cp opkg/CONTROL/postinst $(BUILD_DIR)/opkg-stage/CONTROL/
	@chmod 755 $(BUILD_DIR)/opkg-stage/CONTROL/postinst
	@# Install the binary
	@cp $(BUILD_DIR)/$(BIN_NAME) $(BUILD_DIR)/opkg-stage/usr/local/bin/
	@chmod 755 $(BUILD_DIR)/opkg-stage/usr/local/bin/$(BIN_NAME)
	@# Create the opkg package
	@cd $(BUILD_DIR)/opkg-stage && \
		tar -czf ../data.tar.gz --owner=0 --group=0 ./usr && \
		tar -czf ../control.tar.gz --owner=0 --group=0 -C CONTROL . && \
		echo "2.0" > ../debian-binary && \
		cd .. && ar r $(BIN_NAME)_$(VERSION)_riscv64.ipk debian-binary control.tar.gz data.tar.gz
	@rm -f $(BUILD_DIR)/debian-binary $(BUILD_DIR)/control.tar.gz $(BUILD_DIR)/data.tar.gz
	@echo "opkg package created: $(BUILD_DIR)/$(BIN_NAME)_$(VERSION)_riscv64.ipk"

# Clean build artifacts
.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)

# Format code
.PHONY: fmt
fmt:
	clang-format -i main.cpp

# Lint code
.PHONY: lint
lint:
	@echo "No linter configured for C++"
