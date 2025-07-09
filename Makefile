# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

IMAGE_NAME = df-site-build
REPO_NAME = infrastructure-actions
COMMIT_HASH = 8aee7a080268198548d8d1b4f1315a4fb94bffea

.PHONY: clone build-image build

all: build

# clones the infrastructure-actions repository at a specific commit
clone:
	@if [ ! -d "$(REPO_NAME)" ]; then \
		echo "Cloning $(REPO_NAME) at specific commit $(COMMIT_HASH)..."; \
		git clone --depth 1 https://github.com/apache/infrastructure-actions.git $(REPO_NAME); \
		cd $(REPO_NAME) && git fetch --depth 1 origin $(COMMIT_HASH) && git checkout $(COMMIT_HASH); \
	else \
		echo "$(REPO_NAME) already exists, skipping clone."; \
	fi
	# Pinned to commit $(COMMIT_HASH) due to https://github.com/apache/infrastructure-actions/issues/218

# builds the Docker image with pelicanasf installed
build-image:
	@if ! docker image inspect $(IMAGE_NAME) > /dev/null 2>&1; then \
		echo "Building Docker image $(IMAGE_NAME)..."; \
		docker build -t $(IMAGE_NAME) $(REPO_NAME)/pelican; \
	else \
		echo "Docker image $(IMAGE_NAME) already exists, skipping build."; \
	fi

# runs the Docker container to build the site
build: clone build-image
	docker run -it --rm -p8000:8000 -v $(PWD):/site --entrypoint /bin/bash $(IMAGE_NAME) -c \
		"pelicanasf content -o blog && python3 -m http.server 8000"
