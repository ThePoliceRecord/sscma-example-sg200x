.PHONY: all build clean distclean

all: build

build:
	@mkdir -p build
	@cd build && cmake .. && make

clean:
	@rm -rf build

distclean: clean
	@find . -name "*.o" -delete
	@find . -name "*.so" -delete
	@find . -name "*.a" -delete

help:
	@echo "Available targets:"
	@echo "  all       - Build the project (default)"
	@echo "  build     - Build the project"
	@echo "  clean     - Remove build directory"
	@echo "  distclean - Remove all build artifacts"
	@echo "  help      - Show this help message"
