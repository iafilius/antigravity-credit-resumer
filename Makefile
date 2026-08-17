.PHONY: install build package publish clean validate install-ide help sync push-github release-brew

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
	@echo "  release-brew - Package VSIX, compute sha256, and update Homebrew tap formula"
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
	@if [ ! -d "publish/.git" ]; then \
		echo "Cloning GitHub sub-repo into publish/..." ; \
		rm -rf publish ; \
		git clone https://github.com/iafilius/antigravity-credit-resumer.git publish ; \
	else \
		echo "Ensuring remote origin is set to GitHub..." ; \
		git -C publish remote set-url origin https://github.com/iafilius/antigravity-credit-resumer.git ; \
	fi
	@echo "=== 2. Syncing clean production files ==="
	@cp .gitignore package.json package-lock.json tsconfig.json esbuild.js README.md LICENSE CHANGELOG.md Makefile publish/
	@rsync -av --delete --exclude='*.ts.bak' src/ publish/src/
	@rsync -av --delete docs/ publish/docs/

	@echo "=== 3. Sanity verification inside publish/ ==="
	@cd publish && npm run compile
	@echo "Sync and sanity verification complete!"

push-github: sync
	@echo "=== 4. Committing and Pushing to GitHub ==="
	@cd publish && \
		git add . && \
		(git diff-index --quiet HEAD 2>/dev/null || git commit -m "Public release update $$(date +'%Y-%m-%d %H:%M')") && \
		env -u GITHUB_TOKEN git push -u origin main
	@echo "Successfully published to GitHub!"

release-brew: package
	@echo "=== Updating Homebrew Formula & Tap Repository ==="
	@VERSION=$$(node -p "require('./package.json').version"); \
	VSIX_FILE="antigravity-credit-resumer-$$VERSION.vsix"; \
	SHA=$$(shasum -a 256 "$$VSIX_FILE" | awk '{print $$1}'); \
	TAP_DIR="/Users/arjan/personal/brew_tab"; \
	if [ -d "$$TAP_DIR" ]; then \
		sed -i '' "s|url \"https://github.com/iafilius/antigravity-credit-resumer/releases/download/.*\"|url \"https://github.com/iafilius/antigravity-credit-resumer/releases/download/v$$VERSION/antigravity-credit-resumer-$$VERSION.vsix\"|g" "$$TAP_DIR/Formula/antigravity-credit-resumer.rb"; \
		sed -i '' "s|sha256 \".*\"|sha256 \"$$SHA\"|g" "$$TAP_DIR/Formula/antigravity-credit-resumer.rb"; \
		git -C "$$TAP_DIR" add Formula/antigravity-credit-resumer.rb; \
		(git -C "$$TAP_DIR" diff --cached --quiet || git -C "$$TAP_DIR" commit -m "chore(brew): update antigravity-credit-resumer formula to v$$VERSION"); \
		env -u GITHUB_TOKEN git -C "$$TAP_DIR" push origin main || true; \
		echo "Homebrew tap updated to v$$VERSION ($$SHA)!"; \
	fi

clean:
	rm -rf dist out node_modules *.vsix publish


