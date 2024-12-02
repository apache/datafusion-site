# Apache DataFusion Blog Content

This repository contains the Apache DataFusion blog at https://datafusion.apache.org/blog/

## Setup for Docker

```shell
git clone https://github.com/apache/infrastructure-actions.git
cd infrastructure-actions
docker build -t df-site-build pelican
```

Then within the directory that contains `datafusion-site` you can build and test
the site using:

```shell
docker run --rm -it -p8000:8000 -v $PWD:/site df-site-build:latest
```

Navigate in your web browser to [http://localhost:8000] to view the live website.
This page will monitor and rebuild the site when you make any changes to the file
structure, so you can edit and see the results by just refreshing your browser.

## Publish site

The site publishes using a GitHub action provided by the ASF Infrastructure team.
See the [ASF-Pelican](https://infra.apache.org/asf-pelican.html) site for most details
on how this process works.

To preview your site live, create a branch named `site/my-feature-x`. This should
auto-publish to https://datafusion.staged.apache.org/blog

When you are satisfied with the staged branch, merging into `main` should cause
the site to build via github actions and publish.

#### Check site status

The website is updated from the `asf-site` branch. You can check the status at 
[ASF Infra sitesource](https://infra-reports.apache.org/#sitesource)
