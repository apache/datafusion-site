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

.PHONY: clone-repo sync-repo build-image build

all: build

# clones the infrastructure-actions repository
clone-repo:
	@if [ ! -d "$(REPO_NAME)" ]; then \
		echo "Cloning $(REPO_NAME)..."; \
		git clone --depth 1 https://github.com/apache/infrastructure-actions.git $(REPO_NAME); \
	else \
		echo "$(REPO_NAME) already exists, skipping clone."; \
	fi

# syncs the repository with the latest changes from the main branch
sync-repo: clone-repo
	@cd $(REPO_NAME) && \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "Error: Repository has uncommitted changes. Please clean the repository first."; \
		exit 1; \
	fi; \
	echo "Syncing with origin/main..."; \
    git fetch origin main && \
    git checkout main


# builds the Docker image with pelicanasf installed
build-image:
	@if ! docker image inspect $(IMAGE_NAME) > /dev/null 2>&1; then \
		echo "Building Docker image $(IMAGE_NAME)..."; \
		docker build -t $(IMAGE_NAME) $(REPO_NAME)/pelican; \
	else \
		echo "Docker image $(IMAGE_NAME) already exists, skipping build."; \
	fi

# runs the Docker container to build the site
build: sync-repo build-image
	docker run -it --rm -p8000:8000 -v $(PWD):/site --entrypoint /bin/bash $(IMAGE_NAME) -c \
		"pelicanasf content -o blog && python3 -m http.server 8000"
