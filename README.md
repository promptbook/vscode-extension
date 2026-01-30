# Promptbook VS Code Extension

VS Code extension for AI-powered notebook development.

## Features

### Missing Package Detection

When code execution fails due to a missing Python module, Promptbook automatically detects the error and offers installation options:

```
┌─────────────────────────────────────────────────────────┐
│  Missing Python Packages                            ✕   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  The following packages are required but not installed: │
│                                                         │
│  Import Name          Package Name                      │
│  ─────────────────────────────────────────────────      │
│  cv2             →    [ opencv-python     ]             │
│  PIL             →    [ pillow            ]             │
│  sklearn         →    [ scikit-learn      ]             │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌──────────────┐  ┌────────────────┐  ┌─────────────┐  │
│  │ Install Once │  │ Add to This    │  │ Add to      │  │
│  │              │  │ Cell           │  │ Setup Cell  │  │
│  └──────────────┘  └────────────────┘  └─────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Install Options:**
- **Install Once** - Run `pip install` in the kernel session (temporary)
- **Add to This Cell** - Prepend `!pip install` to the current cell
- **Add to Setup Cell** - Add to cell 0 or an existing cell with pip installs

Package names are automatically mapped (e.g., `cv2` → `opencv-python`) and can be edited before installation.

## Installation

1. Install from VS Code Marketplace (coming soon)
2. Or build from source:

```bash
# Install dependencies
pnpm install

# Build extension
pnpm build

# Package as VSIX
pnpm package
```

## Development

```bash
# Install dependencies
pnpm install

# Start development
pnpm dev

# Run tests
pnpm test
```

## Requirements

- VS Code 1.85+
- Python 3.8+ (for kernel features)
