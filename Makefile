.PHONY: install build package publish clean validate install-ide help sync push-github

# Default target
all: build

help:
	@echo "Available Makefile targets:"
	@echo "  install      - Install npm dependencies"
	@echo "  build        - Compile the extension"
	@echo "  package      - Package the extension into a .vsix file"
	@echo "  publish      - Package and publish to Open VSX (requires TOKEN=<token>)"
	@echo "  validate     - Validate OpenSpec specifications"
	@echo "  install-ide  - Install packaged extension into Antigravity IDE"
	@echo "  sync         - Sync production source code to the local publish folder and run sanity build"
	@echo "  push-github  - Sync, stage, commit, and push public sub-repo to GitHub"
	@echo "  clean        - Clean build artifacts (dist, out, node_modules, vsix, publish)"

install:
	npm install --legacy-peer-deps

build: install
	npm run compile

package: build
	npx vsce package

publish:
	@if [ -z "$(TOKEN)" ]; then \
		echo "Error: TOKEN variable is required. Run 'make publish TOKEN=<open_vsx_token>'"; \
		exit 1; \
	fi
	npx vsce package
	npx ovsx publish *.vsix -t $(TOKEN)

validate:
	openspec validate --all

install-ide: package
	antigravity-ide --install-extension *.vsix

sync: build
	@echo "=== 1. Preparing publish sub-repo ==="
	@mkdir -p publish
	@if [ ! -d "publish/.git" ]; then \
		echo "Initializing Git repository in publish/..." ; \
		cd publish && git init && git checkout -b main; \
	fi
	@if ! git -C publish remote | grep -q origin; then \
		echo "Setting remote origin to GitHub..." ; \
		git -C publish remote add origin https://github.com/arjanfilius/antigravity-credit-resumer.git; \
	fi
	@echo "=== 2. Syncing clean production files ==="
	@cp .gitignore package.json package-lock.json tsconfig.json esbuild.js README.md LICENSE Makefile publish/
	@rsync -av --delete --exclude='*.ts.bak' src/ publish/src/
	@rsync -av --delete docs/ publish/docs/

	@echo "=== 3. Sanity verification inside publish/ ==="
	@cd publish && npm run compile
	@echo "Sync and sanity verification complete!"

push-github: sync
	@echo "=== 4. Committing and Pushing to GitHub ==="
	@cd publish && \
		git add . && \
		(git diff-index --quiet HEAD || git commit -m "Public release update $$(date +'%Y-%m-%d %H:%M')") && \
		git push -u origin main
	@echo "Successfully published to GitHub!"

clean:
	rm -rf dist out node_modules *.vsix publish


