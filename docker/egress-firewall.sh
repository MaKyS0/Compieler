#!/bin/sh
# Egress policy for sandbox containers that are allowed to reach the internet
# (pip/npm install phase, and runs with network enabled).
#
# Containers started with `--network compieler-sandbox` get source addresses from
# SANDBOX_SUBNET. This script installs DOCKER-USER rules that let them reach the public
# internet but never internal infrastructure, the Docker host or cloud metadata endpoints.
# Containers started with `--network none` need none of this.
#
# Run as root on the Docker host after `docker compose up` created the network:
#   sudo ./docker/egress-firewall.sh
set -eu
SANDBOX_SUBNET="${SANDBOX_SUBNET:-172.30.0.0/16}"

iptables -N COMPIELER-EGRESS 2>/dev/null || iptables -F COMPIELER-EGRESS
# Allow replies and DNS to the network's own resolver (Docker's embedded DNS lives on 127.0.0.11, inside the container).
iptables -A COMPIELER-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
    iptables -A COMPIELER-EGRESS -d "$net" -j DROP        # RFC1918, link-local (cloud metadata 169.254.169.254), CGNAT, ...
done
iptables -A COMPIELER-EGRESS -j RETURN

# Hook: traffic originating from the sandbox subnet goes through the chain first.
iptables -C DOCKER-USER -s "$SANDBOX_SUBNET" -j COMPIELER-EGRESS 2>/dev/null || iptables -I DOCKER-USER -s "$SANDBOX_SUBNET" -j COMPIELER-EGRESS
# Sandbox containers must not talk to each other either (icc is off on user-defined networks via the compose option).
echo "egress policy installed for $SANDBOX_SUBNET"
