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

## Updating Dependencies

The JavaScript and CSS files included in this repository are based on the
example from the [ASF Infra](https://github.com/apache/infrastructure-website)
and modified slightly for our purposes. If you need to update these, the core
libraries to use are

- [bootstrap](https://getbootstrap.com/) you can simply download the latest
    bundled minified version and css file. You will want to also include the
    associated `.map` file. This is an common library used to provide a host
    of useful JavaScript functions for websites.
- [highlight.js](https://highlightjs.org/) provides the code colorization
    for the blog posts, making them more readable. To generate a new highlight
    package, you can use the [generator tool](https://highlightjs.org/download).
    When you download this package, you will want to extract the full js file,
    not the minified file or you will not get all of the functionality you
    need.
- [font awesome](https://fontawesome.com/) provides a variety of improved
    fonts for readability. You can simply update the provided css files.
- In addition to these dependencies, we have some custom CSS files to improve
    the site layout. You can edit these files directly.

