#!/bin/bash
# Build script for version-syncing dependencies with installed Python packages

# 1. Get installed Python package versions
JLAB_VER=$(pip show jupyterlab | grep Version | awk '{print $2}')
JLITE_VER=$(pip show jupyterlite-core | grep Version | awk '{print $2}')

echo "Syncing to: JupyterLab $JLAB_VER, JupyterLite $JLITE_VER"

# 2. Install the main packages with exact matching versions
npm install @jupyterlite/kernel@$JLITE_VER @jupyterlab/application@$JLAB_VER

# 3. Resolve compatible versions for coreutils and services
# We query the npm registry to see what version of coreutils/services 
# is required by the specific version of @jupyterlab/application we just identified.
CORE_REQ=$(npm view @jupyterlab/application@$JLAB_VER dependencies.@jupyterlab/coreutils)
SERV_REQ=$(npm view @jupyterlab/application@$JLAB_VER dependencies.@jupyterlab/services)

# 4. Install the resolved versions
npm install @jupyterlab/coreutils@"$CORE_REQ" @jupyterlab/services@"$SERV_REQ"
