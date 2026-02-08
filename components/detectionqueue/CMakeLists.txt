cmake_minimum_required(VERSION 3.10)
project(detectionqueue C)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Create static library
add_library(detectionqueue STATIC
    src/detection_shm.c
)

target_include_directories(detectionqueue PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# Link pthread and rt for shared memory and semaphores
target_link_libraries(detectionqueue
    pthread
    rt
)
