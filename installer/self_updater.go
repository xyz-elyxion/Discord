/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

package main

import "errors"

// Self-updating is disabled in the Limey V1 Installer: users re-download the
// installer from the Limey website. These stubs keep the CLI code unchanged.

var IsSelfOutdated = false
var SelfUpdateCheckDoneChan = make(chan bool, 1)

func init() {
	SelfUpdateCheckDoneChan <- true
}

func GetInstallerDownloadLink() string {
	return BaseUrl + "/download"
}

func CanUpdateSelf() bool {
	return false
}

func UpdateSelf() error {
	return errors.New("Self-update is disabled. Please re-download the installer from " + BaseUrl + "/download")
}

func DeleteOldExecutable() {}
